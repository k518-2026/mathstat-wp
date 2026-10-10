/**
 * 投稿待ちの記事に、研究の流れ図（images/<論文ID>.png）を作る（この PC で動かす）
 *
 *   node make-figures.js            図の無い投稿待ちの記事すべてに作る
 *   node make-figures.js --id=W123  その記事だけ作る（すでにあっても作り直す）
 *   node make-figures.js --force    図があっても作り直す
 *   node make-figures.js --dry      項目を作って描くだけ。images/ にも記事にも書かない
 *   node make-figures.js --report   図の各項目と、論文の本文からの根拠の文を figures/_build/report.txt に書く（人が確かめる用）
 *
 * 図の材料は論文の本文（PDF）。取った本文は figures/_cache に置く（GitHub には送らない）。
 * git には送らない（送るのは generate.js、または手で git add images articles）。
 */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
loadEnv();

const store = require('./lib/store');
const figure = require('./lib/figure');
const config = require('./config');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const REPORT = args.includes('--report');
const idArg = (args.find((a) => /^--id=/.test(a)) || '').slice(5);

/** 人が確かめるための一覧。各項目に、論文の本文からの根拠の文と、本文にあるかの照合の結果を付ける */
async function writeReport(ids) {
  const lines = ['研究の流れ図の項目と根拠（論文の本文から）', ''];
  for (const id of ids) {
    const entry = store.loadArticle(id);
    if (!entry || !entry.figure) { lines.push(id + ' 項目が記録されていません（図を作り直してください）', ''); continue; }
    const text = await figure.getPaperText(entry);
    const ctx = text ? figure.makeContext(text) : null;
    lines.push('■ ' + id + ' ' + (entry.article.titleJa || ''), '  原題: ' + entry.paper.title, '  ' + figure.sourceNote(entry.paper));
    config.figure.columns.forEach((c) => {
      lines.push('  [' + c.title + ']');
      (entry.figure[c.key] || []).forEach((it) => {
        const item = typeof it === 'string' ? { text: it, evidence: '' } : it;
        const ok = ctx && item.evidence ? (figure.itemProblems(item, ctx).length === 0 ? '照合OK' : '照合NG') : '根拠なし';
        lines.push('    ・' + figure.plainItem(item.text) + '  〔' + ok + '〕', '        根拠: ' + (item.evidence || '（記録なし）'));
      });
    });
    lines.push('');
  }
  const file = path.join(store.ROOT, 'figures', '_build', 'report.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log('一覧を書きました: ' + file);
}

async function main() {
  const ids = idArg ? [idArg] : store.queue(store.loadLedger(), store.loadPosted());
  const count = { have: 0, made: 0, failed: 0 };
  for (const id of ids) {
    const result = await figure.ensureFigure(id, { force: FORCE || !!idArg, write: !DRY });
    // 続けて作ると Gemini の1分あたりの上限（429）に当たる。作った（言語モデルを呼んだ）あとは少し待つ
    if (result !== 'have' && id !== ids[ids.length - 1]) await new Promise((r) => setTimeout(r, 70000));
    count[result]++;
    if (result === 'failed') console.warn('  → ' + id + ' の図は作れませんでした（図ができるまで、この記事は投稿されません）');
  }
  console.log('図: 作った ' + count.made + ' 枚 / すでにあった ' + count.have + ' 枚 / 作れなかった ' + count.failed + ' 枚');
  if (REPORT) await writeReport(ids);
  if (count.failed) process.exitCode = 1;
}

main().catch((e) => { console.error('失敗: ' + (e.stack || e.message)); process.exitCode = 1; });
