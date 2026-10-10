/**
 * 貯めた記事を1本、WordPress へメールで投稿する（GitHub Actions で毎日 5時）
 *
 *   node publish.js          図のある、いちばん古い投稿待ちを1本送り、data/posted.json に記録する
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
const figure = require('./lib/figure');
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

  // 図のある、いちばん古い記事を選ぶ。図の無い記事は飛ばす（写真は使わない）
  const next = store.nextToPost(waiting, figure.hasFigure);
  if (next.skipped.length) console.warn('図が無いため飛ばした記事: ' + next.skipped.join(', ') + '（この PC で make-figures.js を動かすと作れます）');
  const id = pick || next.id;
  if (!id) {
    console.error(waiting.length
      ? '投稿待ちの ' + waiting.length + ' 本には、どれも研究の流れ図がありません。この PC で make-figures.js を動かして push してください。'
      : '投稿する記事がありません。手元の PC で generate.js が動いているか確かめてください。');
    process.exitCode = 1;
    return;
  }
  if (posted[id] && posted[id].wpSentAt) throw new Error(id + ' はすでに ' + posted[id].wpSentAt + ' に送っています。');
  const entry = store.loadArticle(id);
  if (!entry) throw new Error('記事のファイルがありません: ' + store.articlePath(id));

  // 画像は、この PC で作った「研究の流れ図」（images/<論文ID>.png）だけ。
  // 2026-10-11 のユーザー判断で Pixabay の写真はやめた（具体的な研究手法の図のほうが価値がある）
  const image = figure.loadFigureImage(id);
  if (!image) throw new Error(id + ' の研究の流れ図（images/' + id + '.png）がありません。図の無い記事は投稿しません。');
  console.log('研究の流れ図を添付します: images/' + id + '.png');

  const subject = render.wordPressTitle(entry);
  const html = render.buildArticleHtml(entry, { shortcodes: true, imageCredit: image && image.credit });
  // WordPress の不正検知に引っかからないよう、リンクも URL も本文に入れない。残っていれば送らずに止める
  render.assertNoLinks(html);
  render.assertNoLinks(subject);
  console.log('件名: ' + subject + '\n画像: ' + image.credit);

  if (DRY) {
    console.log('[--dry] 送りません。\n' + html);
    return;
  }

  await wordpress.sendPost(subject, html, image);
  posted[id] = { wpSentAt: nowStamp(), subject, imageCredit: image.credit };
  store.savePosted(posted);
  console.log('WordPress に送りました: ' + subject);
}

main().catch((e) => {
  console.error('失敗: ' + (e.stack || e.message));
  process.exitCode = 1;
});
