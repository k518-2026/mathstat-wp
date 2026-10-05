/**
 * 記事の組み立て（GAS 版 Render.gs から移植）
 *
 *   HTML … WordPress（メール投稿）
 *   短文 … Bluesky の誘導文
 *
 * 書誌の書式: [著者，"タイトル，" ジャーナル名，vol. 巻，no. 号，pp. ページ，年](論文リンク) ＋ 被引用数。
 * 欠けている項目は飛ばす。リンクはすべて別ウィンドウ。Wikipedia へのリンクは記事全体で最初の1回だけ。
 *
 * WordPress のメール投稿は <hr> や "--" 以降を署名とみなして削るので、どちらも出力しない。
 */
const config = require('../config');
const { escapeHtml, formatNumber, stripAstral, toGraphemes, truncateGraphemes, decodeEntities } = require('./text');

// ============================================================
// 書誌
// ============================================================

function authorsLabel(p) {
  const list = p.authors || [];
  const count = p.authorCount || list.length;
  if (!list.length) return '';
  if (count <= 3) return list.join(', ');
  return list.slice(0, 3).join(', ') + ', et al.';
}

function citationText(p) {
  const parts = [];
  const au = authorsLabel(p);
  if (au) parts.push(au);
  parts.push('"' + String(p.title || '').replace(/[\s.。]+$/, '') + '，"');
  if (p.venue) parts.push(p.venue);
  if (p.volume) parts.push('vol. ' + p.volume);
  if (p.issue) parts.push('no. ' + p.issue);
  if (p.pages) parts.push((/[–-]/.test(p.pages) ? 'pp. ' : 'p. ') + p.pages);
  if (p.year) parts.push(p.year);
  return parts.join('，').replace('，"，', '，" ');
}

function citedByText(p, asOf) {
  return '被引用数: ' + formatNumber(p.citedBy) + '（OpenAlex, ' + asOf + ' 時点）';
}

// ============================================================
// リンクを出さない（WordPress の不正検知への対策）
// ============================================================

/**
 * WordPress に送る本文には、リンク（<a href>）も、URL の文字列も入れない（2026-10-05 ユーザー指示）。
 *   ・書誌は「DOI: 10.xxxx/…」の文字だけにする（DOI は https:// を付けなければ自動リンクにならない）
 *   ・Wikipedia の用語リンクは付けず、用語は文字のまま
 *   ・写真の出典は URL を除く（WordPress は文字だけの URL も自動でリンクにする）
 * 組み立てで避けたうえで、最後に removeLinks で取り除く（言語モデルの文章に混ざった URL への備え）
 */
function doiLine(p) {
  const doi = String((p && p.doi) || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
  return doi ? 'DOI: ' + doi : '';
}

/** 写真の出典から URL を除く（"Pixabay / WOKANDAPIX https://…" → "Pixabay / WOKANDAPIX"） */
function plainCredit(credit) {
  return String(credit || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').replace(/[\s/]+$/, '').trim();
}

/** <a …>文字</a> を文字だけにし、残った URL も取り除く。doi.org の URL は「DOI: …」に直す */
function removeLinks(html) {
  return String(html)
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/https?:\/\/(?:dx\.)?doi\.org\/(\S+?)(?=[\s<"'),;]|[.,]?$|[.,]?\s)/gi, 'DOI: $1')
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')]+/gi, '')
    .replace(/mailto:\S+/gi, '');
}

/** 本文にリンクや URL が残っていれば、送る前に止める（残っていれば何が残ったかを示す） */
function assertNoLinks(html) {
  const left = String(html).match(/<a\b[^>]*>|https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|mailto:\S+/gi);
  if (left) throw new Error('WordPress に送る本文にリンクが残っています: ' + left.slice(0, 3).join(' / '));
}

function paragraphs(text) {
  return String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

// ============================================================
// HTML（WordPress）
// ============================================================

/**
 * entry は articles/<id>.json の中身（{paper, article, asOf}）。
 * opts.imageCredit … 写真の出典（本文末尾の注記に入れる）
 * opts.shortcodes … WordPress のメール投稿用の指定子を末尾に付ける
 */
function buildArticleHtml(entry, opts = {}) {
  const a = entry.article;
  const p = entry.paper;
  const out = [];
  // 書誌・DOI・被引用数を <br /> でつなぐ（DOI が無い論文は DOI の行を出さない）
  const bibliography = (paper) => [escapeHtml(citationText(paper)), escapeHtml(doiLine(paper)), escapeHtml(citedByText(paper, entry.asOf))]
    .filter(Boolean).join('<br />');

  out.push('<p>' + escapeHtml(config.articleLead) + '</p>');
  out.push('<p><strong>原題</strong>: ' + escapeHtml(p.title) + '<br />' + bibliography(p) + '</p>');

  config.sections.forEach((s) => {
    out.push('<h2>' + escapeHtml(s.heading) + '</h2>');
    paragraphs(a.sections[s.key]).forEach((para) => out.push('<p>' + escapeHtml(para) + '</p>'));
    if (s.lead) {
      if ((a.nextReads || []).length) {
        out.push('<ul>');
        a.nextReads.forEach((n) => out.push('<li>' + bibliography(n.paper) + '<br />' + escapeHtml(n.reason) + '</li>'));
        out.push('</ul>');
      } else {
        out.push('<p>OpenAlex で関連する論文を確認できなかったため、候補は挙げていません。</p>');
      }
    }
  });

  out.push('<p><small>' + escapeHtml(disclaimer(plainCredit(opts.imageCredit))) + '</small></p>');

  if (opts.shortcodes) {
    // WordPress.com のメール投稿が解釈する指定子。記事本文には出力されない
    const wp = config.wordpress;
    if (wp.category) out.push('[category ' + wp.category + ']');
    if (wp.tags) out.push('[tags ' + wp.tags + ']');
    if (wp.draft) out.push('[status draft]');
    out.push('[publicize off]');   // WordPress 側の自動共有は切る。告知は announce.js が行う
    out.push('[end]');             // これ以降（署名など）を本文に含めない
  }
  return stripAstral(removeLinks(out.join('\n')));
}

function disclaimer(imageCredit) {
  const lines = ['この記事は、論文の本文（オープンアクセス版の PDF）をもとに AI が要約・翻訳したものです。' +
                 '正確な内容は原論文をご確認ください。書誌と被引用数は OpenAlex によります。'];
  if (imageCredit) lines.push('画像: ' + imageCredit);
  return lines.join(' ');
}

function wordPressTitle(entry) {
  return stripAstral(config.wordpress.titlePrefix + (entry.article.titleJa || entry.paper.title));
}

// ============================================================
// RSS（WordPress の記事 URL を探す）
// ============================================================

/** WordPress は引用符や記号を置き換え、長いタイトルに空白を挟むことがあるので、文字だけで比べる */
function feedKey(s) {
  return stripAstral(String(s || '')).replace(/[\s"'“”‘’「」『』【】\[\]()（）、。,.:：!?！？…-]/g, '').toLowerCase();
}

/** RSS の item からタイトルが一致する記事の URL。guid の短い形（?p=番号）があればそちら */
function findInFeed(xml, title) {
  const want = feedKey(title);
  const items = String(xml).split(/<item[\s>]/).slice(1);
  for (const item of items) {
    const t = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
    const link = (item.match(/<link>([^<]+)<\/link>/) || [])[1];
    if (t && link && feedKey(decodeEntities(t)) === want) return shortWordPressUrl(item) || link.trim();
  }
  return '';
}

/**
 * 日本語タイトルの記事URLは符号化されて 240 字ほどになり、Bluesky の 300 字に入らなくなる（2026-09-22）。
 * RSS の guid にある短い形（?p=番号）を使う
 */
function shortWordPressUrl(item) {
  const guid = (String(item).match(/<guid[^>]*>([^<]+)<\/guid>/) || [])[1] || '';
  const m = guid.match(/^https?:(\/\/[^\s?]+\/\?p=\d+)$/);
  return m ? 'https:' + m[1] : '';
}

// ============================================================
// Bluesky の誘導文
// ============================================================

/**
 * Bluesky は 300 グラフェムまで。こちらの数え方が Bluesky と完全には一致せず、
 * 300 ちょうどを狙って 302・305 で弾かれた（2026-09-20・21）。余白を取り、組み立てたあとにも数え直す。
 */
const BLUESKY = { LIMIT: 300, RESERVE: 8, MIN_INTRO: 60, TITLE_MAX: 60, TITLE_MIN: 25 };

/** 字数で切った文を、できれば文末（。！？）まで戻す */
function cutAtSentence(original, cut) {
  if (cut === original) return cut;
  const body = cut.replace(/…$/, '');
  const m = body.match(/^[\s\S]*[。！？!?]/);
  if (m && Array.from(m[0]).length >= Array.from(body).length * 0.4) return m[0];
  return cut;
}

function buildBlueskyText(entry, url) {
  const tags = (config.snsHashtags || []).join(' ');
  const limit = BLUESKY.LIMIT - BLUESKY.RESERVE;
  const fullTitle = entry.article.titleJa || entry.paper.title;
  const tailOf = (titleMax, withUrl) => '\n\n【論文紹介】' + truncateGraphemes(fullTitle, titleMax) +
    (tags ? '\n' + tags : '') + (withUrl ? '\n' + url : '');

  // 末尾が長すぎると紹介文が消える。タイトル → 本文中の URL の順に削る（URL はリンクカードからも開ける）
  let tail = tailOf(BLUESKY.TITLE_MAX, true);
  const room = (t) => toGraphemes(t).length <= limit - BLUESKY.MIN_INTRO;
  if (!room(tail)) tail = tailOf(BLUESKY.TITLE_MIN, true);
  if (!room(tail)) tail = tailOf(BLUESKY.TITLE_MAX, false);
  if (!room(tail)) tail = tailOf(BLUESKY.TITLE_MIN, false);

  const budget = limit - toGraphemes(tail).length;
  const introFull = entry.article.intro || '';
  let intro = cutAtSentence(introFull, truncateGraphemes(introFull, budget));
  let length = toGraphemes(intro).length;
  while (length > 0 && toGraphemes(intro + tail).length > limit) {
    length--;
    intro = length > 0 ? truncateGraphemes(intro, length) : '';
  }
  return intro + tail;
}

module.exports = {
  citationText, citedByText, doiLine, plainCredit, removeLinks, assertNoLinks, buildArticleHtml, wordPressTitle, disclaimer,
  feedKey, findInFeed, shortWordPressUrl, buildBlueskyText, cutAtSentence, BLUESKY
};
