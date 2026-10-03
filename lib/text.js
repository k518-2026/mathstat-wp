/** 文字列の小道具（GAS 版 Core.gs から移植） */

function normalizeSpace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** LLM の出力に混ざりがちな囲み記号・URL・Markdown 記号を落とす（本文用） */
function cleanProse(text) {
  return String(text == null ? '' : text)
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 日本語の文字数。空白と改行は数えない */
function jaLength(s) {
  return Array.from(String(s == null ? '' : s).replace(/\s/g, '')).length;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** &amp; を最後に処理するのが要点。先に処理すると &amp;lt; が < まで戻ってしまう */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * BMP外（UTF-8で4バイト）の文字を取り除く。
 * WordPress で 📄 が「������」に化けた。日本語は3バイトなので通る。
 */
function stripAstral(s) {
  return String(s == null ? '' : s)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/[︀-️‍]/g, '')
    .replace(/ {2,}/g, ' ');
}

/**
 * タイトル全体を囲む鉤括弧だけを外す。
 * 「「自己調整学習」の研究」のように途中で閉じる括弧は、タイトルの一部なので残す。
 */
function unwrapQuotes(s) {
  const t = String(s || '').trim();
  if (/^[「『"][\s\S]*[」』"]$/.test(t) && !/[」』]/.test(t.slice(1, -1))) return t.slice(1, -1).trim();
  return t;
}

function formatNumber(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Bluesky はグラフェム単位で数える */
function toGraphemes(s) {
  const str = String(s == null ? '' : s);
  return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(str), (x) => x.segment);
}

function truncateGraphemes(s, max) {
  const g = toGraphemes(s);
  if (g.length <= max) return String(s == null ? '' : s);
  return g.slice(0, Math.max(0, max - 1)).join('').replace(/[\s、。,.]+$/, '') + '…';
}

/** 日本時間の 'yyyy-MM-dd HH:mm'。toISOString() は UTC なので使わない */
function nowStamp(date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date || new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** 'yyyy-MM-dd HH:mm'（日本時間）からの経過時間。読めなければ Infinity */
function hoursSince(stamp, now) {
  const m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return Infinity;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
  return ((now || Date.now()) - t) / 3600000;
}

module.exports = {
  normalizeSpace, cleanProse, jaLength, escapeHtml, decodeEntities, stripAstral, unwrapQuotes,
  formatNumber, toGraphemes, truncateGraphemes, nowStamp, hoursSince
};
