/**
 * 記事に添える写真（Pixabay）
 *
 * Pixabay は**ホットリンク禁止**。投稿のときに落として、メールに添付する。
 * 公開リポジトリに写真そのものは置かない（再配布にあたらないように）。
 * 鍵は PIXABAY_API_KEY。無ければ画像なしで投稿する。
 */
const { fetchRetry, hasEnv } = require('./http');
const config = require('../config');

/**
 * 写真のタグが話題に合うか。Pixabay の hits[].tags は "heart, couple, together" のようなカンマ区切り。
 * config.photoTopicWords のどれか（または math で始まる語）があれば合格。
 * tags の項目が無い応答（仕様が変わったとき）は、写真が出なくなるのを避けるため合格にする
 */
function onTopic(hit) {
  if (hit.tags === undefined) return true;
  const words = String(hit.tags).toLowerCase().split(/[\s,]+/).filter(Boolean);
  return words.some((w) => /^math/.test(w) || config.photoTopicWords.includes(w));
}

async function findPhoto(query) {
  if (!hasEnv('PIXABAY_API_KEY')) {
    console.log('PIXABAY_API_KEY が未設定なので、画像なしで投稿します。');
    return null;
  }
  const queries = [query, config.photoFallbackQuery].filter(Boolean);
  for (const q of queries) {
    const url = 'https://pixabay.com/api/?' + new URLSearchParams({
      key: process.env.PIXABAY_API_KEY.trim(), q: q.slice(0, 100), image_type: 'photo', orientation: 'horizontal',
      safesearch: 'true', lang: 'en', order: 'popular', min_width: '1000', per_page: '20'
    }).toString();
    const res = await fetchRetry(url, {}, { attempts: 2 });
    if (!res.ok) { console.warn('Pixabay APIエラー(' + res.status + ')'); continue; }
    const found = (await res.json()).hits || [];
    if (!found.length) { console.log('Pixabay に該当なし: ' + q); continue; }
    // 写真のタグが話題（算数・学校など）に合うものだけから選ぶ。
    // 検索語に引っかかっただけの写真（数直線の記事に「寄り添うカップル」）が当たったため（2026-10-10）
    const hits = found.filter(onTopic);
    if (!hits.length) { console.log('話題に合う写真が無い: ' + q + '（タグ: ' + found.slice(0, 5).map((h) => h.tags).join(' | ') + '）'); continue; }
    // 上位から1枚。毎回先頭にすると、似た検索語の日に同じ写真が続く
    const hit = hits[Math.floor(Math.random() * Math.min(hits.length, 10))];
    return { url: hit.largeImageURL || hit.webformatURL, smallUrl: hit.webformatURL, user: hit.user || '', pageURL: hit.pageURL || '', query: q };
  }
  return null;
}

/** 写真を落とす。大きければ小さい版にする。返り値は {buffer, filename, contentType, credit} */
async function downloadPhoto(photo, baseName) {
  let res = await fetchRetry(photo.url, {}, { attempts: 2 });
  let buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  if (buf && buf.length > config.imageMaxBytes && photo.smallUrl) {
    res = await fetchRetry(photo.smallUrl, {}, { attempts: 2 });
    buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  if (!buf) throw new Error('写真を取得できませんでした(' + res.status + ')');
  return {
    buffer: buf,
    filename: baseName + '.jpg',
    contentType: 'image/jpeg',
    credit: 'Pixabay / ' + photo.user + (photo.pageURL ? ' ' + photo.pageURL : '')
  };
}

module.exports = { findPhoto, downloadPhoto };
