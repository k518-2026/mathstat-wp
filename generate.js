/**
 * 記事を作って貯める（この Windows PC で動かす。タスク スケジューラーから run-generate.cmd 経由）
 *
 *   node generate.js            投稿待ちが config.backlogTarget 本に満たなければ、最大 config.maxPerRun 本作って push する
 *   node generate.js --force    投稿待ちの本数に関係なく1本作る
 *   node generate.js --no-git   git pull / push をしない（試すとき）
 *   node generate.js --dry      記事を作ってログに出すだけ。台帳にも書かない
 *   node generate.js --id=W123  その論文だけを記事にする（--dry と組み合わせて試せる）
 *   node generate.js --only-local  外部 API（Gemini・Claude）を使わず、手元の Ollama と LM Studio だけで書く（確かめるとき）
 *
 * 流れ: git pull → OpenAlex で候補 → PDF → pdftotext → 記事（手元の Ollama → LM Studio → Gemini → Claude）→
 *       Wikipedia で用語を確認 → articles/<ID>.json と data/ledger.json → git commit → push
 *
 * どのモデルも使えなかったときは、そこで止めて終了コード 1 で終わる（黙って0本で終わらない）。
 */
const { execFileSync } = require('child_process');
const { loadEnv } = require('./lib/env');
loadEnv();

const config = require('./config');
const store = require('./lib/store');
const openalex = require('./lib/openalex');
const pdf = require('./lib/pdf');
const writer = require('./lib/writer');
const wikipedia = require('./lib/wikipedia');
const figure = require('./lib/figure');
const { nowStamp } = require('./lib/text');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const NO_GIT = args.includes('--no-git') || args.includes('--dry');
const DRY = args.includes('--dry');
// 手元の2台（Ollama・LM Studio）だけで書かせる（外部 API を使わない。手元の流れを確かめるとき）。--only-ollama は古い名前
if (args.includes('--only-local') || args.includes('--only-ollama')) {
  require('./lib/llm').state.noExternal = true;
}

function git(...a) {
  return execFileSync('git', a, { cwd: store.ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function today() {
  return nowStamp().slice(0, 10);
}

/** 論文1本を記事にする。返り値は 'ready' / 'skipped'。どのモデルも使えなければ transient なエラーを投げる */
async function processPaper(ledger, paper) {
  console.log('\n候補: ' + paper.title + '（被引用 ' + paper.citedBy + '、' + paper.year + '）');
  const base = { doi: paper.doi, title: paper.title, citedBy: paper.citedBy, year: paper.year };
  const skip = (note) => {
    console.log('  飛ばしました: ' + note);
    if (!DRY) ledger.papers[paper.id] = { ...base, status: store.STATUS.SKIPPED, note, checkedAt: nowStamp() };
    return 'skipped';
  };

  if (config.titleExclude && config.titleExclude.test(paper.title)) return skip('タイトルが除外条件に一致');
  const file = await pdf.fetchPdf(paper);
  if (!file) return skip('PDF を取得できない');
  const text = pdf.extractText(file);
  if (text.length < config.pdfTextMinChars) return skip('PDF から本文の文字を取り出せない（' + text.length + ' 字）');
  console.log('  本文 ' + text.length + ' 字');

  const readings = await openalex.readingCandidates(paper);
  const article = await writer.writeArticle(paper, text, readings);
  if (!article.relevant) return skip('テーマ外: ' + article.relevanceReason);

  try {
    article.links = await wikipedia.verifyTerms(article.terms);
  } catch (e) {
    article.links = [];
    article.warnings.push('Wikipedia の確認に失敗したためリンクなし: ' + e.message);
  }
  await wikipedia.checkSenses(article);

  const entry = {
    paper: { ...writer.citationFields(paper), license: paper.license, pdfUrl: file.url },
    article,
    asOf: today(),
    createdAt: nowStamp()
  };
  const lengths = config.sections.map((s) => writer.sectionLength(article, s.key)).join('/');
  console.log('  記事完成: ' + article.titleJa + '（' + article.model + '、字数 ' + lengths +
              '、用語リンク ' + article.links.length + '、次に読む論文 ' + article.nextReads.length + '）' +
              (article.warnings.length ? '\n  注意: ' + article.warnings.join(' / ') : ''));

  // 研究の流れ図（images/<論文ID>.png）。作れなくても記事は捨てない（図ができるまで投稿されず、次の実行で作り直す）
  // 材料は記事ではなく論文の本文（text）。根拠の文が本文にある項目だけが図に入る
  const figureSpec = await figure.makeFigure(paper.id, entry, { write: !DRY, paperText: text });
  if (figureSpec) entry.figure = figureSpec;
  console.log('  研究の流れ図: ' + (figureSpec ? '作りました' : '作れませんでした（次の実行で作り直します。図ができるまで投稿されません）'));

  if (DRY) {
    console.log(JSON.stringify(entry, null, 2));
    return 'ready';
  }
  store.saveArticle(paper.id, entry);
  ledger.papers[paper.id] = {
    ...base, status: store.STATUS.READY, titleJa: article.titleJa, model: article.model,
    createdAt: entry.createdAt, note: article.warnings.join(' / ')
  };
  return 'ready';
}

/** 恒久的な失敗を記録する（3回で error） */
function recordFailure(ledger, paper, e) {
  const prev = ledger.papers[paper.id] || {};
  const fails = (Number(prev.fails) || 0) + 1;
  ledger.papers[paper.id] = {
    doi: paper.doi, title: paper.title, citedBy: paper.citedBy, year: paper.year,
    status: fails >= 3 ? store.STATUS.ERROR : store.STATUS.RETRY,
    fails, note: nowStamp() + ' ' + e.message.slice(0, 300)
  };
  console.warn('  失敗（' + fails + '回目）: ' + e.message);
}

/**
 * 変わったものがあれば GitHub に送る。articles・台帳・images（研究の流れ図。投稿のときに添付する）が対象。
 * touched は今回見た候補と作った記事の数、figures は今回補った図の数（どちらも 0 なら何もしない）
 */
function pushToGitHub(touched, figures) {
  if (NO_GIT || touched + figures === 0) return;
  git('add', config.paths.ledger, config.paths.articles, 'images');
  const changed = git('diff', '--cached', '--name-only');
  if (!changed) return;
  git('commit', '-m', 'Add articles and figures ' + nowStamp());
  // Actions が posted.json を push していることがあるので、取り込んでから送る
  git('pull', '--rebase');
  git('push');
  console.log('GitHub に送りました: ' + git('log', '-1', '--format=%h %s'));
}

async function main() {
  console.log('=== ' + config.name + ' 記事作成 ' + nowStamp() + ' ===');
  if (!NO_GIT) console.log(git('pull', '--rebase', '--autostash'));

  const ledger = store.loadLedger();
  const posted = store.loadPosted();

  // 論文を指定して1本だけ（試すとき・作り直すとき）
  const idArg = args.find((a) => /^--id=/.test(a));
  if (idArg) {
    const result = await processPaper(ledger, await openalex.fetchWorkById(idArg.slice(5)));
    if (!DRY) store.saveLedger(ledger);
    console.log('\n結果: ' + result + '（git には送っていません）');
    return;
  }

  const backlog = store.queue(ledger, posted).length;
  console.log('投稿待ち ' + backlog + ' 本（目標 ' + config.backlogTarget + ' 本）');

  // 図の無い投稿待ちの記事に、研究の流れ図を作る。図の無い記事は投稿されないので、貯まっていても毎回確かめる
  // （写真は使わない。2026-10-11 のユーザー判断）
  const figuresMade = { made: 0, failed: 0 };
  for (const id of store.queue(ledger, posted)) {
    const r = await figure.ensureFigure(id, { write: !DRY });
    if (r === 'made') figuresMade.made++;
    if (r === 'failed') figuresMade.failed++;
  }
  if (figuresMade.made || figuresMade.failed) console.log('図を補いました: 作った ' + figuresMade.made + ' 枚 / 作れなかった ' + figuresMade.failed + ' 枚');

  const quota = FORCE ? 1 : Math.min(config.maxPerRun, config.backlogTarget - backlog);
  if (quota <= 0) {
    console.log('十分に貯まっているので、今回は作りません。');
    pushToGitHub(0, figuresMade.made);
    return;
  }

  let made = 0;
  let tried = 0;
  let stopped = null;
  const save = () => { if (!DRY) store.saveLedger(ledger); };

  const attempt = async (paper) => {
    tried++;
    try {
      if (await processPaper(ledger, paper) === 'ready') made++;
    } catch (e) {
      if (e.transient) { stopped = e; return; }
      if (!DRY) recordFailure(ledger, paper, e);
    }
    save();
  };

  // 前に失敗した論文を先に片付ける
  for (const [id, p] of Object.entries(ledger.papers)) {
    if (made >= quota || stopped || tried >= config.maxTriesPerRun) break;
    if (p.status !== store.STATUS.RETRY) continue;
    await attempt(await openalex.fetchWorkById(id));
  }

  for (let page = 1; page <= config.maxSearchPages && made < quota && !stopped && tried < config.maxTriesPerRun; page++) {
    const result = await openalex.searchCandidates(page);
    if (page === 1) console.log('検索条件に合う論文: ' + result.total + ' 件');
    for (const paper of result.papers) {
      if (made >= quota || stopped || tried >= config.maxTriesPerRun) break;
      if (store.isKnown(ledger, paper)) continue;
      await attempt(paper);
    }
    if (result.papers.length < config.perPage) break;
  }

  console.log('\n記事を ' + made + ' 本作りました（候補 ' + tried + ' 本を確認）。');

  pushToGitHub(made + tried, figuresMade.made);

  if (stopped) {
    console.error('\n途中で止めました: ' + stopped.message);
    process.exitCode = 1;
  } else if (made === 0 && quota > 0) {
    console.error('\n記事を1本も作れませんでした（候補がすべて対象外か失敗）。');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('失敗: ' + (e.stack || e.message));
  process.exitCode = 1;
}).finally(() => require('./lib/llm').lmstudioRelease());   // この実行で読み込んだ LM Studio のモデルを外す（共用サーバーのメモリを空ける）
