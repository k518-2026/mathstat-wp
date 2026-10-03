/**
 * 専門用語のリンク（日本語版 Wikipedia）
 *
 * ・項目が実在するかを必ず API で確かめる（「効果量」「認知負荷理論」は項目が無かった）
 * ・曖昧さ回避のページには張らない
 * ・**項目が実在しても意味が違うことがある**（「測定の信頼性」が工学の「信頼性」に張られた。2026-09-15）。
 *   冒頭の文を取り、記事の文脈と合うかを言語モデルに判定させ、合うと言われたものだけ残す
 */
const { fetchRetry } = require('./http');
const llm = require('./llm');
const config = require('../config');

const API = 'https://ja.wikipedia.org/w/api.php';

/** 実在する項目だけ {term, title, url, extract} で返す */
async function verifyTerms(terms) {
  const wanted = terms.filter((t) => t.term && (t.wikiTitle || t.term));
  if (!wanted.length) return [];

  const names = [];
  wanted.forEach((t) => [t.wikiTitle, t.term].forEach((n) => { if (n && !names.includes(n)) names.push(n); }));
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'pageprops|extracts', ppprop: 'disambiguation',
    exintro: '1', explaintext: '1', exchars: '200', exlimit: 'max',
    titles: names.slice(0, 50).join('|')
  });
  const res = await fetchRetry(API + '?' + params.toString(), {}, { attempts: 2 });
  if (!res.ok) throw new Error('Wikipedia APIエラー(' + res.status + ')');
  return resolveTerms(wanted, (await res.json()).query || {});
}

/** API の応答から用語ごとのリンク先を決める（通信しない部分。テストで使う） */
function resolveTerms(terms, query) {
  const hop = {};
  (query.normalized || []).concat(query.redirects || []).forEach((m) => { hop[m.from] = m.to; });
  const pages = {};
  (query.pages || []).forEach((p) => {
    const ok = !p.missing && !p.invalid && !((p.pageprops || {}).disambiguation !== undefined);
    pages[p.title] = ok ? p : null;
  });
  const resolve = (name) => {
    let t = String(name || '').trim();
    for (let i = 0; i < 3 && hop[t]; i++) t = hop[t];
    return pages[t] ? pages[t] : null;
  };

  const out = [];
  const used = {};
  terms.forEach((t) => {
    if (used[t.term]) return;
    const page = resolve(t.wikiTitle) || resolve(t.term);
    if (!page) return;
    used[t.term] = true;
    out.push({
      term: t.term,
      title: page.title,
      url: 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(page.title.replace(/ /g, '_')),
      extract: String(page.extract || '').trim()
    });
  });
  return out;
}

/** 項目の意味が記事の文脈と合うかを判定させ、合うものだけ残す。判定できなければリンクは外す */
async function checkSenses(article) {
  const links = article.links || [];
  if (!links.length) return;

  const body = config.sections.map((s) => article.sections[s.key]).join('\n');
  const lines = links.map((l, i) => {
    const at = body.indexOf(l.term);
    const context = at === -1 ? '' : body.slice(Math.max(0, at - 60), at + l.term.length + 60).replace(/\s+/g, ' ');
    return `[${i + 1}] 用語: ${l.term}\n    記事での使われ方: …${context}…\n` +
           `    Wikipedia「${l.title}」の冒頭: ${l.extract || '（取得できず）'}`;
  });
  const schema = {
    type: 'OBJECT',
    properties: {
      results: { type: 'ARRAY', items: { type: 'OBJECT',
        properties: { number: { type: 'INTEGER' }, fits: { type: 'BOOLEAN' } }, required: ['number', 'fits'] } }
    },
    required: ['results']
  };

  try {
    const judged = await llm.generateJson([{ text:
      '【用語の意味の確認】\n次の各用語について、記事での意味と、リンク先の Wikipedia 項目の意味が同じかを判定してください。\n' +
      '同じ分野・同じ概念を指していれば fits を true、分野が違う（例: 心理測定の「信頼性」に対して工学の信頼性の項目）、' +
      'または冒頭の文から判断できない場合は false にしてください。\n\n' + lines.join('\n\n') }], schema);
    const ok = new Set((judged.results || []).filter((r) => r.fits === true).map((r) => Number(r.number) - 1));
    const removed = links.filter((l, i) => !ok.has(i)).map((l) => l.term + '→' + l.title);
    article.links = links.filter((l, i) => ok.has(i));
    if (removed.length) article.warnings.push('意味が合わないリンクを外した: ' + removed.join(', '));
  } catch (e) {
    article.links = [];
    article.warnings.push('用語の意味を確認できなかったためリンクなし: ' + e.message.slice(0, 80));
  }
  article.links.forEach((l) => { delete l.extract; });   // 記事データには残さない
}

module.exports = { verifyTerms, resolveTerms, checkSenses };
