/**
 * 投稿待ちの記事に、研究の流れ図（images/<論文ID>.png）を作る（この PC で動かす）
 *
 *   node make-figures.js            図の無い投稿待ちの記事すべてに作る
 *   node make-figures.js --id=W123  その記事だけ作る（すでにあっても作り直す）
 *   node make-figures.js --force    図があっても作り直す
 *   node make-figures.js --dry      語句を作って描くだけ。images/ にも記事にも書かない
 *
 * git には送らない（送るのは generate.js、または手で git add images articles）。
 */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
loadEnv();

const store = require('./lib/store');
const figure = require('./lib/figure');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const idArg = (args.find((a) => /^--id=/.test(a)) || '').slice(5);

async function main() {
  const ledger = store.loadLedger();
  const ids = idArg ? [idArg] : store.queue(ledger, store.loadPosted());
  let made = 0;
  for (const id of ids) {
    const have = fs.existsSync(path.join(figure.IMAGES_DIR, id + '.png'));
    if (have && !FORCE && !idArg) { console.log(id + ' は図があります'); continue; }
    const entry = store.loadArticle(id);
    if (!entry) { console.warn(id + ' の記事がありません'); continue; }
    console.log(id + ' ' + entry.article.titleJa);
    const spec = await figure.makeFigure(id, entry.article, { write: !DRY });
    if (!spec) { console.warn('  → 作れませんでした（投稿のときは Pixabay の写真になります）'); continue; }
    console.log('  → 作りました: ' + JSON.stringify(spec));
    if (!DRY) { entry.figure = spec; store.saveArticle(id, entry); }
    made++;
  }
  console.log('図を ' + made + ' 枚作りました。');
}

main().catch((e) => { console.error('失敗: ' + (e.stack || e.message)); process.exitCode = 1; });
