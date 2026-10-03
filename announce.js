/**
 * WordPress に出た記事を Bluesky で告知する（GitHub Actions で 9・10・19・20時と、投稿の直後）
 *
 *   node announce.js         送った記事のうち、まだ告知していないものを確かめる
 *   node announce.js --dry   投稿せずに、告知文をログに出す
 *
 * メール投稿は記事 URL を返さないので、サイトの RSS からタイトルで探す。
 * 見つかるまでは config.wpWaitHours 時間待ち、過ぎたら「告知なし」で終える（終了コード 1 で知らせる）。
 */
const { loadEnv } = require('./lib/env');
loadEnv();

const config = require('./config');
const store = require('./lib/store');
const render = require('./lib/render');
const bluesky = require('./lib/bluesky');
const { fetchRetry, requireEnv } = require('./lib/http');
const { nowStamp, hoursSince } = require('./lib/text');

const DRY = process.argv.includes('--dry');

async function fetchFeed() {
  const site = requireEnv('WP_SITE_URL').replace(/\/+$/, '');
  const res = await fetchRetry(site + '/feed/', {}, { attempts: 2 });
  if (!res.ok) throw new Error('WordPress の RSS を取得できませんでした(' + res.status + ')');
  return res.text();
}

async function main() {
  const posted = store.loadPosted();
  const targets = Object.keys(posted).filter((id) => posted[id].wpSentAt && !posted[id].snsUrl);
  if (!targets.length) { console.log('告知を待っている記事はありません。'); return; }

  const feed = await fetchFeed();
  let changed = false;
  for (const id of targets) {
    const rec = posted[id];
    const entry = store.loadArticle(id);
    if (!entry) { console.error('記事のファイルがありません: ' + id); process.exitCode = 1; continue; }

    const url = rec.wpUrl || render.findInFeed(feed, render.wordPressTitle(entry));
    if (!url) {
      if (hoursSince(rec.wpSentAt) < config.wpWaitHours) {
        console.log('告知待ち（WordPress の RSS にまだ出ていない）: ' + rec.subject);
        continue;
      }
      rec.snsUrl = '（告知なし: ' + config.wpWaitHours + '時間待っても RSS に出なかった）';
      console.error('告知を見送りました（RSS に出ない）: ' + rec.subject);
      process.exitCode = 1;
      changed = true;
      continue;
    }

    const text = render.buildBlueskyText(entry, url);
    if (DRY) { console.log('[--dry] ' + url + '\n' + text); continue; }
    try {
      rec.wpUrl = url;
      rec.snsUrl = await bluesky.post(text, entry, url);
      rec.announcedAt = nowStamp();
      console.log('Bluesky に告知しました: ' + rec.snsUrl + '（誘導先 ' + url + '）');
    } catch (e) {
      rec.note = nowStamp() + ' ' + e.message.slice(0, 300);
      console.error('告知に失敗: ' + e.message);
      process.exitCode = 1;
    }
    changed = true;
  }
  if (changed && !DRY) store.savePosted(posted);
}

main().catch((e) => {
  console.error('失敗: ' + (e.stack || e.message));
  process.exitCode = 1;
});
