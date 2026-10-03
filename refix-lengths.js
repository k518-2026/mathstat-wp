/**
 * 貯めた記事（まだ投稿していないもの）の、字数が外れた観点だけを書き直す。
 *
 *   node refix-lengths.js          書き直して articles/*.json を更新する（git には送らない）
 *   node refix-lengths.js --dry    どの記事のどの観点が外れているかを一覧にするだけ
 *
 * 字数の判定を厳しくしたとき（2026-10-04）に、すでに貯めた記事を直すために作った。
 */
const { loadEnv } = require('./lib/env');
loadEnv();

const config = require('./config');
const store = require('./lib/store');
const writer = require('./lib/writer');

const DRY = process.argv.includes('--dry');

async function main() {
  const ledger = store.loadLedger();
  const posted = store.loadPosted();
  for (const id of store.queue(ledger, posted)) {
    const entry = store.loadArticle(id);
    const bad = writer.sectionsOutOfRange(entry.article).filter((s) => !s.lead);
    console.log(id + ' ' + entry.article.titleJa + ' → ' +
      (bad.length ? bad.map((s) => s.key + ' ' + writer.sectionLength(entry.article, s.key) + '字').join(', ') : '字数は範囲内'));
    if (!bad.length || DRY) continue;

    entry.article.warnings = (entry.article.warnings || []).filter((w) => !/ が \d+ 字$/.test(w));
    await writer.fixSectionLengths(entry.article);
    const after = config.sections.map((s) => writer.sectionLength(entry.article, s.key)).join('/');
    console.log('  書き直し後: ' + after + (entry.article.warnings.length ? ' 注意: ' + entry.article.warnings.join(' / ') : ''));
    store.saveArticle(id, entry);
  }
}

main().catch((e) => { console.error('失敗: ' + (e.stack || e.message)); process.exitCode = 1; });
