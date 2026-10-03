/**
 * Bluesky（AT Protocol）への告知。GAS 版 Publish.gs から移植
 *
 * 鍵は BLUESKY_HANDLE と BLUESKY_PASSWORD（アプリパスワード）。
 * リンクカードの画像は、WordPress の記事ページの og:image を使う（写真をリポジトリに置かないため）。
 */
const { fetchRetry, httpError, requireEnv } = require('./http');
const { toGraphemes, truncateGraphemes } = require('./text');
const { BLUESKY } = require('./render');

const XRPC = 'https://bsky.social/xrpc/';

async function session() {
  const res = await fetchRetry(XRPC + 'com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: requireEnv('BLUESKY_HANDLE'), password: requireEnv('BLUESKY_PASSWORD') })
  });
  if (!res.ok) throw await httpError('Blueskyログイン失敗', res);
  const d = await res.json();
  return { token: d.accessJwt, did: d.did };
}

/** facet の位置は文字数ではなく UTF-8 のバイト位置で指定する */
function facets(text) {
  const out = [];
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  let m;
  const re = /https?:\/\/[^\s]+/g;
  while ((m = re.exec(text)) !== null) {
    const start = bytes(text.slice(0, m.index));
    out.push({ index: { byteStart: start, byteEnd: start + bytes(m[0]) },
               features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  // 行頭か空白の直後の # だけをハッシュタグにする（URL の #fragment を拾わない）
  const tagRe = /(^|\s)(#[^\s#]+)/g;
  while ((m = tagRe.exec(text)) !== null) {
    const at = m.index + m[1].length;
    const start = bytes(text.slice(0, at));
    out.push({ index: { byteStart: start, byteEnd: start + bytes(m[2]) },
               features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2].slice(1) }] });
  }
  return out;
}

/** 記事ページの og:image を落とす（1MB まで）。取れなければ null */
async function pageImage(pageUrl) {
  try {
    const page = await fetchRetry(pageUrl, { redirect: 'follow' }, { attempts: 2 });
    if (!page.ok) return null;
    const html = await page.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
              html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return null;
    const img = await fetchRetry(m[1].replace(/&amp;/g, '&'), {}, { attempts: 2 });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 950000) return null;
    return { buffer: buf, contentType: img.headers.get('content-type') || 'image/jpeg' };
  } catch (e) {
    console.warn('記事の画像を取れませんでした（カードは画像なし）: ' + e.message);
    return null;
  }
}

async function uploadBlob(s, image) {
  const res = await fetchRetry(XRPC + 'com.atproto.repo.uploadBlob', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + s.token, 'Content-Type': image.contentType },
    body: image.buffer
  });
  if (!res.ok) throw await httpError('Bluesky画像アップロードエラー', res);
  return (await res.json()).blob;
}

function createPost(s, record) {
  return fetchRetry(XRPC + 'com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record })
  });
}

/** 字数超過で弾かれたときの超過分。それ以外は 0 */
async function overage(res) {
  if (res.status !== 400) return 0;
  const m = (await res.clone().text()).match(/grapheme too big \(maximum (\d+), got (\d+)\)/);
  return m ? Number(m[2]) - Number(m[1]) : 0;
}

/** 告知文の紹介文（1つ目の空行より前）だけを削る。タイトル・タグ・URL は残す */
function shrinkText(text, over) {
  const at = String(text).indexOf('\n\n');
  if (at <= 0) return '';
  const intro = text.slice(0, at);
  const keep = toGraphemes(intro).length - over - BLUESKY.RESERVE;
  if (keep < 20) return '';
  return truncateGraphemes(intro, keep) + text.slice(at);
}

/** 告知を投稿し、投稿の URL を返す */
async function post(text, entry, linkUrl) {
  const s = await session();
  const external = {
    uri: linkUrl,
    title: truncateGraphemes(entry.article.titleJa || entry.paper.title, 100),
    description: truncateGraphemes(entry.paper.title + ' — ' + entry.paper.venue, 300)
  };
  const image = await pageImage(linkUrl);
  if (image) {
    try { external.thumb = await uploadBlob(s, image); }
    catch (e) { console.warn('サムネイルを上げられませんでした: ' + e.message); }
  }

  const record = {
    $type: 'app.bsky.feed.post', text, facets: facets(text), langs: ['ja'],
    createdAt: new Date().toISOString(),
    embed: { $type: 'app.bsky.embed.external', external }
  };
  console.log('Bluesky 告知文 ' + toGraphemes(text).length + '字（上限 ' + BLUESKY.LIMIT + '・余白 ' + BLUESKY.RESERVE + '）');
  let res = await createPost(s, record);
  const over = await overage(res);
  if (over > 0) {
    const shorter = shrinkText(text, over);
    if (shorter) {
      console.warn('Bluesky の字数超過（' + over + '字）。紹介文を削って出し直します。');
      record.text = shorter;
      record.facets = facets(shorter);
      res = await createPost(s, record);
    }
  }
  if (!res.ok) throw await httpError('Bluesky投稿エラー', res);
  const rkey = String((await res.json()).uri || '').split('/').pop();
  return 'https://bsky.app/profile/' + requireEnv('BLUESKY_HANDLE') + '/post/' + rkey;
}

module.exports = { post, facets, shrinkText, pageImage };
