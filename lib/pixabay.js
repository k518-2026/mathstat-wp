/**
 * 記事に添える写真（Pixabay）
 *
 * Pixabay は**ホットリンク禁止**。投稿のときに落として、メールに添付する。
 * 公開リポジトリに写真そのものは置かない（再配布にあたらないように）。
 * 鍵は PIXABAY_API_KEY。無ければ画像なしで投稿する。
 */
const { fetchRetry, hasEnv } = require('./http');
const config = require('../config');

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
    const hits = (await res.json()).hits || [];
    if (!hits.length) { console.log('Pixabay に該当なし: ' + q); continue; }
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
