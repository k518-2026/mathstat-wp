/**
 * 貯めた記事を1本、WordPress へメールで投稿する（GitHub Actions で毎日 8時・18時）
 *
 *   node publish.js          いちばん古い投稿待ちを1本送り、data/posted.json に記録する
 *   node publish.js --dry    送らずに、件名と本文をログに出す
 *   node publish.js <論文ID>  その記事を送る（順番を飛ばしたいとき）
 *
 * 投稿待ちが無いときは終了コード 1 で終わる（PC が止まって記事が尽きたことに気づけるように）。
 */
const { loadEnv } = require('./lib/env');
loadEnv();

const config = require('./config');
const store = require('./lib/store');
const render = require('./lib/render');
const pixabay = require('./lib/pixabay');
const wordpress = require('./lib/wordpress');
const { nowStamp } = require('./lib/text');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const pick = args.find((a) => !a.startsWith('--'));

async function main() {
  const ledger = store.loadLedger();
  const posted = store.loadPosted();
  const waiting = store.queue(ledger, posted);
  console.log('投稿待ち ' + waiting.length + ' 本');

  const id = pick || waiting[0];
  if (!id) {
    console.error('投稿する記事がありません。手元の PC で generate.js が動いているか確かめてください。');
    process.exitCode = 1;
    return;
  }
  if (posted[id] && posted[id].wpSentAt) throw new Error(id + ' はすでに ' + posted[id].wpSentAt + ' に送っています。');
  const entry = store.loadArticle(id);
  if (!entry) throw new Error('記事のファイルがありません: ' + store.articlePath(id));

  // 写真。取れなくても記事は出す
  let image = null;
  try {
    const photo = await pixabay.findPhoto(entry.article.imageQuery);
    if (photo) image = await pixabay.downloadPhoto(photo, 'mathstat-' + id.toLowerCase());
  } catch (e) {
    console.warn('写真の用意に失敗（画像なしで投稿します）: ' + e.message);
  }

  const subject = render.wordPressTitle(entry);
  const html = render.buildArticleHtml(entry, { shortcodes: true, imageCredit: image && image.credit });
  console.log('件名: ' + subject + '\n画像: ' + (image ? image.credit : 'なし'));

  if (DRY) {
    console.log('[--dry] 送りません。\n' + html);
    return;
  }

  await wordpress.sendPost(subject, html, image);
  posted[id] = { wpSentAt: nowStamp(), subject, imageCredit: image ? image.credit : '' };
  store.savePosted(posted);
  console.log('WordPress に送りました: ' + subject);
}

main().catch((e) => {
  console.error('失敗: ' + (e.stack || e.message));
  process.exitCode = 1;
});
