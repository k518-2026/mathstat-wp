/**
 * 記事を作って貯める（この Windows PC で動かす。タスク スケジューラーから run-generate.cmd 経由）
 *
 *   node generate.js            投稿待ちが config.backlogTarget 本に満たなければ、最大 config.maxPerRun 本作って push する
 *   node generate.js --force    投稿待ちの本数に関係なく1本作る
 *   node generate.js --no-git   git pull / push をしない（試すとき）
 *   node generate.js --dry      記事を作ってログに出すだけ。台帳にも書かない
 *
 * 流れ: git pull → OpenAlex で候補 → PDF → pdftotext → 記事（Gemini → Ollama → Claude）→
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
const { nowStamp } = require('./lib/text');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const NO_GIT = args.includes('--no-git') || args.includes('--dry');
const DRY = args.includes('--dry');

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

async function main() {
  console.log('=== ' + config.name + ' 記事作成 ' + nowStamp() + ' ===');
  if (!NO_GIT) console.log(git('pull', '--rebase', '--autostash'));

  const ledger = store.loadLedger();
  const posted = store.loadPosted();
  const backlog = store.queue(ledger, posted).length;
  console.log('投稿待ち ' + backlog + ' 本（目標 ' + config.backlogTarget + ' 本）');

  const quota = FORCE ? 1 : Math.min(config.maxPerRun, config.backlogTarget - backlog);
  if (quota <= 0) { console.log('十分に貯まっているので、今回は作りません。'); return; }

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

  if (!NO_GIT && made + tried > 0) {
    git('add', config.paths.ledger, config.paths.articles);
    const changed = git('diff', '--cached', '--name-only');
    if (changed) {
      git('commit', '-m', 'Add ' + made + ' article(s) ' + nowStamp());
      // Actions が posted.json を push していることがあるので、取り込んでから送る
      git('pull', '--rebase');
      git('push');
      console.log('GitHub に送りました: ' + git('log', '-1', '--format=%h %s'));
    }
  }

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
});
