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
const { loadEnv } = require('./lib/env');
loadEnv();

const store = require('./lib/store');
const figure = require('./lib/figure');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const idArg = (args.find((a) => /^--id=/.test(a)) || '').slice(5);

async function main() {
  const ids = idArg ? [idArg] : store.queue(store.loadLedger(), store.loadPosted());
  const count = { have: 0, made: 0, failed: 0 };
  for (const id of ids) {
    const result = await figure.ensureFigure(id, { force: FORCE || !!idArg, write: !DRY });
    count[result]++;
    if (result === 'failed') console.warn('  → ' + id + ' の図は作れませんでした（図ができるまで、この記事は投稿されません）');
  }
  console.log('図: 作った ' + count.made + ' 枚 / すでにあった ' + count.have + ' 枚 / 作れなかった ' + count.failed + ' 枚');
  if (count.failed) process.exitCode = 1;
}

main().catch((e) => { console.error('失敗: ' + (e.stack || e.message)); process.exitCode = 1; });
