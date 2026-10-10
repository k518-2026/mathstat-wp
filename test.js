/**
 * 自己検査（通信はすべて偽物。GitHub Actions でも投稿の前に走る）
 *
 *   node test.js
 *
 * 確かめていないこと（実機で確かめる）: Gemini・Ollama・Claude の出力の質、WordPress・Bluesky の実際の応答
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const llm = require('./lib/llm');
const writer = require('./lib/writer');
const render = require('./lib/render');
const store = require('./lib/store');
const wikipedia = require('./lib/wikipedia');
const { loadEnv } = require('./lib/env');
const { toGraphemes } = require('./lib/text');

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  if (!ok) realLog('  NG ' + name + (detail !== undefined ? '  → ' + String(detail).slice(0, 300) : ''));
}

// 待ち時間を消し、ログを黙らせる（NG だけを出す）
config.geminiRoundWaitMs = 0;
require('./lib/http').timing.retryBaseMs = 0;
const realLog = console.log;
console.log = () => {};
console.warn = () => {};

/** fetch を偽物にする。route(url, opts) は {status, body} を返す */
function fakeFetch(route) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const r = await route(String(url), opts);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {});
    return new Response(body, { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

function geminiOk(obj) {
  return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] } };
}
const BUSY = { status: 503, body: { error: { code: 503, message: 'high demand' } } };
const CLASSIFY_YES = { body: { message: { content: JSON.stringify({ aboutMathLearning: true, quantitativeStatistics: true,
  brainImagingIsMainTopic: false, explainsStatisticalMethodOnly: false, qualitativeOnly: false }) }, done_reason: 'stop' } };
function isClassify(opts) {
  const b = JSON.parse(opts.body || '{}');
  return !!(b.format && b.format.properties && b.format.properties.aboutMathLearning);
}
const OLLAMA_TAGS = { body: { models: [{ name: config.ollama.model }] } };

function fakeClaude(out, seen) {
  llm.createClaudeClient = () => ({
    messages: { create: async (req) => {
      seen.push(req);
      return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
               content: [{ type: 'text', text: JSON.stringify(out) }] };
    } }
  });
}

function setEnv(env) {
  ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY'].forEach((k) => { delete process.env[k]; });
  Object.assign(process.env, env);
}

const PAPER = {
  id: 'W1', doi: '10.1/x', title: 'Math anxiety and word problems', authors: ['A. One', 'B. Two'],
  venue: 'Educational Studies in Mathematics', volume: '100', issue: '3', pages: '271–290', year: '2018',
  citedBy: 64, url: 'https://doi.org/10.1/x', pdfUrls: [], referencedWorks: []
};
const PAPER_TEXT = 'We studied 145 fourth graders. The model explained 21% of variance (R2 = .21, p < .001). ' +
                   'Working memory was measured.\n'.repeat(3);

function rawArticle(numbers) {
  const s = 'この研究の説明です。'.repeat(20);
  return {
    relevant: true, relevanceReason: '算数の量的研究', titleJa: '「数学不安と文章題」',
    sections: { what: '小学4年生' + numbers + '名を対象にしました。' + s, novelty: s, method: 'ワーキングメモリを測りました。' + s, validation: s, implications: s,
                nextLead: '次は不安の研究へ進むとよいです。' },
    nextReads: [{ number: 1, reason: '関係の説明です。'.repeat(8) }, { number: 9, reason: '範囲外' }],
    terms: [{ term: 'ワーキングメモリ', wikiTitle: 'ワーキングメモリ' }, { term: '本文に無い語', wikiTitle: 'x' }],
    intro: '数学不安は文章題に関わるのでしょうか。'
  };
}
const READINGS = [{ id: 'W2', title: 'Next paper', venue: 'J', year: '2020', citedBy: 10, relation: 'x', authors: ['C'], url: 'https://doi.org/2' }];

async function run() {
  // ---------- スキーマ ----------
  const js = llm.toJsonSchema({ type: 'OBJECT', properties: { a: { type: 'STRING' },
    b: { type: 'ARRAY', items: { type: 'OBJECT', properties: { n: { type: 'INTEGER' } } } } } });
  check('スキーマ: 小文字・additionalProperties false・全項目必須',
        js.type === 'object' && js.additionalProperties === false && js.required.join() === 'a,b' &&
        js.properties.b.items.additionalProperties === false && js.properties.b.items.properties.n.type === 'integer', JSON.stringify(js));

  // ---------- 言語モデルの順番 ----------
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  let calls = fakeFetch((url) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return OLLAMA_TAGS;
    if (url.endsWith('/api/chat')) return { body: { message: { content: JSON.stringify({ ok: 1 }) }, done_reason: 'stop' } };
    return { status: 404 };
  });
  const claudeSeen = [];
  fakeClaude({ ok: 3 }, claudeSeen);
  let out = await llm.generateJson([{ text: 'x' }], { type: 'OBJECT', properties: { ok: { type: 'INTEGER' } } });
  const gem1 = calls.filter((c) => c.url.includes('generativelanguage')).length;
  check('Gemini が全部混雑なら Ollama で書く（Gemini は全モデル×2回×巡回数）',
        out.ok === 1 && llm.usedModel() === config.ollama.model &&
        gem1 === config.geminiModels.length * 2 * config.geminiRounds && claudeSeen.length === 0, gem1);
  const sentToOllama = JSON.parse(calls.find((c) => c.url.endsWith('/api/chat')).opts.body);
  check('Ollama にはスキーマ（format）と num_ctx を渡す',
        sentToOllama.format && sentToOllama.format.additionalProperties === false && sentToOllama.options.num_ctx === config.ollama.composeNumCtx);

  calls.length = 0;
  out = await llm.generateJson([{ text: 'y' }], { type: 'OBJECT', properties: { ok: { type: 'INTEGER' } } });
  check('一度 Gemini が全滅したら、その実行では Gemini を飛ばす',
        out.ok === 1 && !calls.some((c) => c.url.includes('generativelanguage')), calls.map((c) => c.url).join(' '));

  // Ollama に届かない → Claude
  llm.reset();
  calls = fakeFetch((url) => {
    if (url.includes('generativelanguage')) return BUSY;
    throw new Error('connect ECONNREFUSED');
  });
  out = await llm.generateJson([{ text: 'x' }], { type: 'OBJECT', properties: { ok: { type: 'INTEGER' } } });
  check('Ollama に届かなければ Claude で書く（構造化出力の指定つき）',
        out.ok === 3 && llm.usedModel() === config.claude.model &&
        claudeSeen[0].output_config.format.type === 'json_schema' && claudeSeen[0].model === config.claude.model);

  // どれも使えない → transient
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G' });
  fakeFetch((url) => {
    if (url.includes('generativelanguage')) return BUSY;
    throw new Error('connect ECONNREFUSED');
  });
  let err = null;
  try { await llm.generateJson([{ text: 'x' }], { type: 'OBJECT' }); } catch (e) { err = e; }
  check('どれも使えなければ、論文の失敗に数えないエラー', err && err.transient, err && err.message);

  // Gemini の 400 以外のエラーは隠さない
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G' });
  fakeFetch(() => ({ status: 401, body: { error: { message: 'API key not valid' } } }));
  err = null;
  try { await llm.generateJson([{ text: 'x' }], { type: 'OBJECT' }); } catch (e) { err = e; }
  check('Gemini の鍵の誤り（401）は次へ回さずに投げる', err && /401/.test(err.message) && !err.transient, err && err.message);

  // ---------- 記事の執筆 ----------
  const chunks = writer.splitChunks('a'.repeat(100) + '\n' + 'b'.repeat(100) + '\n' + 'c'.repeat(50), 120);
  check('本文を段落の切れ目で区切る', chunks.length === 3 && chunks.join('') === 'a'.repeat(100) + '\n' + 'b'.repeat(100) + '\n' + 'c'.repeat(50), chunks.map((c) => c.length));

  const art = writer.normalize(rawArticle('145'), READINGS);
  check('数値の照合: 本文にある数値（145・21%・.21 を 0.21 と書いた）は通す',
        writer.checkNumbers({ sections: { ...art.sections, validation: '分散の21%を説明し、R2は0.21でした。' }, nextReads: [] }, PAPER_TEXT).length === 0,
        writer.checkNumbers({ sections: { ...art.sections, validation: '分散の21%を説明し、R2は0.21でした。' }, nextReads: [] }, PAPER_TEXT));
  check('数値の照合: 本文に無い数値（150・0.35）を見つける',
        writer.checkNumbers({ sections: { ...art.sections, what: '150名', validation: 'r = 0.35' }, nextReads: [] }, PAPER_TEXT).join() === '150,0.35');
  check('数値の照合: 本文にある2つの整数の和（77名＋71名＝148名）は許し、無関係な数（150）は見つける',
        writer.checkNumbers({ sections: { ...art.sections, what: '合計148名' }, nextReads: [] }, '2nd grade (n = 77) and 4th grade (n = 71) participated.').length === 0 &&
        writer.checkNumbers({ sections: { ...art.sections, what: '合計150名' }, nextReads: [] }, '2nd grade (n = 77) and 4th grade (n = 71) participated.').join() === '150');
  check('数値の照合: 「115万9295」を 1,159,295 として探す・「3万」と「1億2000万」も直す',
        writer.checkNumbers({ sections: { ...art.sections, what: '115万9295件、3万人、1億2000万円' }, nextReads: [] },
          'sum 1,159,295 sets, 30,000 students and 120,000,000 yen').length === 0 &&
        writer.checkNumbers({ sections: { ...art.sections, what: '115万9295件' }, nextReads: [] }, 'sum 1,159,296').join() === '1159295');
  check('整える: 鉤括弧を外す・範囲外の番号と本文に無い用語を落とす・写真の検索語は持たない',
        art.titleJa === '数学不安と文章題' && art.nextReads.length === 1 && art.terms.length === 1 &&
        !('imageQuery' in art), JSON.stringify([art.titleJa, art.nextReads.length, art.terms, art.imageQuery]));

  // Ollama が書いた記事の数値が本文に無い → Claude で書き直す
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  let ollamaCalls = 0;
  fakeFetch((url, opts) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return OLLAMA_TAGS;
    if (url.endsWith('/api/chat')) {
      if (isClassify(opts)) return CLASSIFY_YES;
      ollamaCalls++;
      return { body: { message: { content: ollamaCalls === 1 ? '・145名の4年生' : JSON.stringify(rawArticle('999')) }, done_reason: 'stop' } };
    }
    return { status: 404 };
  });
  claudeSeen.length = 0;
  fakeClaude(rawArticle('145'), claudeSeen);
  const a1 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
  check('Ollama の記事に本文に無い数値（999）があれば、Claude で全文から書き直す',
        a1.model === config.claude.model && /145名/.test(a1.sections.what) && claudeSeen.length >= 1, a1.model + ' ' + a1.sections.what.slice(0, 20));

  // 数値が合っていれば Ollama の記事を使う
  llm.reset();
  ollamaCalls = 0;
  fakeFetch((url, opts) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return OLLAMA_TAGS;
    if (url.endsWith('/api/chat')) {
      if (isClassify(opts)) return CLASSIFY_YES;
      ollamaCalls++;
      return { body: { message: { content: ollamaCalls === 1 ? '・145名の4年生' : JSON.stringify(rawArticle('145')) }, done_reason: 'stop' } };
    }
    return { status: 404 };
  });
  claudeSeen.length = 0;
  const a2 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
  check('Ollama の記事の数値が本文と合えば、そのまま使う（Claude は呼ばない）',
        a2.model === config.ollama.model && claudeSeen.length === 0, a2.model);

  // 記事を書かせた回の relevant ではなく、問いを分けた判定で決める（2026-10-04 に理由と結論が食い違った）
  for (const [brain, want] of [[false, true], [true, false]]) {
    llm.reset();
    ollamaCalls = 0;
    fakeFetch((url, opts) => {
      if (url.includes('generativelanguage')) return BUSY;
      if (url.endsWith('/api/tags')) return OLLAMA_TAGS;
      if (url.endsWith('/api/chat')) {
        if (isClassify(opts)) {
          return { body: { message: { content: JSON.stringify({ aboutMathLearning: true, quantitativeStatistics: true,
            brainImagingIsMainTopic: brain, explainsStatisticalMethodOnly: false, qualitativeOnly: false }) }, done_reason: 'stop' } };
        }
        ollamaCalls++;
        return { body: { message: { content: ollamaCalls === 1 ? '・145名' : JSON.stringify({ ...rawArticle('145'), relevant: false }) }, done_reason: 'stop' } };
      }
      return { status: 404 };
    });
    const a3 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
    check('Ollama: テーマの判定は問いを分けた答えで決める（脳画像が中心=' + brain + ' → ' + (want ? '記事にする' : 'テーマ外') + '）',
          a3.relevant === want && (want || /脳画像/.test(a3.relevanceReason)), a3.relevant + ' ' + a3.relevanceReason);
  }

  // ---------- 新しい Ollama モデル（全文を1回で読む） ----------
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  const chatBodies = [];
  fakeFetch((url, opts) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return { body: { models: [{ name: 'qwen3.5:9b' }, { name: 'gemma4:12b' }, { name: config.ollama.model }] } };
    if (url.endsWith('/api/chat')) {
      const b = JSON.parse(opts.body);
      chatBodies.push(b);
      if (isClassify(opts)) return CLASSIFY_YES;
      return { body: { message: { content: JSON.stringify(rawArticle('145')) }, done_reason: 'stop' } };
    }
    return { status: 404 };
  });
  claudeSeen.length = 0;
  const a4 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
  const writing = chatBodies.filter((b) => !(b.format && b.format.properties && b.format.properties.aboutMathLearning));
  check('全文を読めるモデル（先頭の gemma4:12b）が入っていれば、論文を区切らず1回で読ませる',
        a4.model === 'gemma4:12b' && writing.length === 1 && writing[0].model === 'gemma4:12b' &&
        writing[0].options.num_ctx === config.ollama.fullTextNumCtx && writing[0].messages[0].content.includes('Working memory was measured'),
        a4.model + ' ' + writing.length);
  check('Ollama には think: false を付ける（付けないと考えるだけで枠を使い切り、本文が空になる）',
        chatBodies.every((b) => b.think === false));

  // 先頭のモデルが空の応答 → 次のモデル
  llm.reset();
  chatBodies.length = 0;
  fakeFetch((url, opts) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return { body: { models: [{ name: 'qwen3.5:9b' }, { name: 'gemma4:12b' }] } };
    if (url.endsWith('/api/chat')) {
      const b = JSON.parse(opts.body);
      chatBodies.push(b);
      if (isClassify(opts)) return CLASSIFY_YES;
      return { body: { message: { content: b.model === 'gemma4:12b' ? '' : JSON.stringify(rawArticle('145')) }, done_reason: 'stop' } };
    }
    return { status: 404 };
  });
  const a5 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
  check('先頭のモデル（gemma4:12b）が空の応答なら、次のモデル（qwen3.5:9b）で書く', a5.model === 'qwen3.5:9b', a5.model);

  // どちらも入っていない → 従来の分割読み
  llm.reset();
  ollamaCalls = 0;
  fakeFetch((url, opts) => {
    if (url.includes('generativelanguage')) return BUSY;
    if (url.endsWith('/api/tags')) return OLLAMA_TAGS;
    if (url.endsWith('/api/chat')) {
      if (isClassify(opts)) return CLASSIFY_YES;
      ollamaCalls++;
      return { body: { message: { content: ollamaCalls === 1 ? '・145名' : JSON.stringify(rawArticle('145')) }, done_reason: 'stop' } };
    }
    return { status: 404 };
  });
  const a6 = await writer.writeArticle(PAPER, PAPER_TEXT, READINGS);
  check('新しいモデルが入っていなければ、従来の分割読み（qwen2.5:14b）に戻る', a6.model === config.ollama.model && ollamaCalls === 2, a6.model + ' ' + ollamaCalls);

  // ---------- 字数 ----------
  const short = { sections: { what: 'a'.repeat(130), nextLead: 'b'.repeat(70) },
                  nextReads: [{ reason: 'c'.repeat(80) }, { reason: 'd'.repeat(80) }] };
  check('(6) は導入文＋推薦理由で数える', writer.sectionLength(short, 'nextLead') === 230);

  // ---------- 用語リンク ----------
  const links = wikipedia.resolveTerms(
    [{ term: '構造方程式モデリング', wikiTitle: '構造方程式モデリング' }, { term: '信頼性', wikiTitle: '信頼性 (曖昧さ回避)' },
     { term: '効果量', wikiTitle: '効果量' }],
    { redirects: [{ from: '構造方程式モデリング', to: '共分散構造分析' }],
      pages: [{ title: '共分散構造分析', extract: '統計' }, { title: '信頼性 (曖昧さ回避)', pageprops: { disambiguation: '' } },
              { title: '効果量', missing: true }] });
  check('Wikipedia: 転送先にリンクし、曖昧さ回避と存在しない項目は張らない',
        links.length === 1 && links[0].title === '共分散構造分析', JSON.stringify(links));

  // ---------- HTML ----------
  const entry = {
    paper: { ...writer.citationFields(PAPER), authors: ['A. One', 'B. Two', 'C. Three', 'D. Four'], authorCount: 5 },
    article: { ...art, links: [{ term: 'ワーキングメモリ', title: 'ワーキングメモリ', url: 'https://ja.wikipedia.org/wiki/x' }],
               sections: { ...art.sections, method: 'ワーキングメモリとワーキングメモリ📄を測りました。' } },
    asOf: '2026-10-04'
  };
  entry.paper.doi = '10.1007/s10649-017-9788-x';
  entry.article.nextReads = [{ paper: { ...entry.paper, id: 'W2', title: 'Next paper', doi: '10.3926/jotse.401', url: 'https://doi.org/10.3926/jotse.401' }, reason: '関連します。' },
                             { paper: { ...entry.paper, id: 'W3', title: 'No doi paper', doi: '', url: 'https://example.com/x' }, reason: '別の論文です。' }];
  const html = render.buildArticleHtml(entry, { shortcodes: true, imageCredit: 'Pixabay / someone https://pixabay.com/photos/x-123/' });
  check('HTML: 書誌の書式・et al.・被引用数', html.includes('A. One, B. Two, C. Three, et al.，&quot;Math anxiety and word problems，&quot; Educational Studies in Mathematics，vol. 100，no. 3，pp. 271–290，2018') &&
        html.includes('被引用数: 64（OpenAlex, 2026-10-04 時点）'), html.slice(0, 600));
  check('HTML: リンク（<a>）も URL も本文に入れない（WordPress の不正検知への対策）',
        !/<a\b/i.test(html) && !/https?:\/\//i.test(html) && !/www\./i.test(html) && !html.includes('target="_blank"'), html.match(/<a\b[^>]*>|https?:\/\/\S+/g));
  check('HTML: 書誌は「DOI: 10.xxxx/…」の文字だけ（原題・次に読む論文）。DOI が無い論文は DOI の行を出さない',
        html.includes('DOI: 10.1007/s10649-017-9788-x') && html.includes('DOI: 10.3926/jotse.401') && (html.match(/DOI: /g) || []).length === 2 &&
        html.includes('No doi paper'));
  check('HTML: Wikipedia の用語リンクは付けず、用語は文字のまま', !html.includes('wikipedia') && html.includes('ワーキングメモリ'));
  check('HTML: 写真の出典は URL を除く', html.includes('画像: Pixabay / someone') && !html.includes('pixabay.com'), html.match(/画像:[^<]*/));
  check('HTML: メール投稿の指定子・[end]・<hr> と -- が無い・絵文字を落とす',
        html.includes('[category 論文紹介]') && html.includes('[publicize off]') && html.trim().endsWith('[end]') &&
        !html.includes('<hr') && !html.includes('--') && !html.includes('📄'));

  // 言語モデルの文章に URL が混ざっていても、送る前に除く・除けなければ止める
  const dirty = JSON.parse(JSON.stringify(entry));
  dirty.article.sections.what = '詳しくは https://example.com/a や www.example.org/b を見てください。DOI は https://doi.org/10.1/abc です。';
  const htmlDirty = render.buildArticleHtml(dirty, { shortcodes: true });
  check('HTML: 本文に混ざった URL は取り除き、doi.org の URL は「DOI: …」の文字にする',
        !/https?:\/\/|www\./.test(htmlDirty) && htmlDirty.includes('DOI: 10.1/abc'), htmlDirty.match(/詳しくは[^<]*/));
  let blocked = null;
  try { render.assertNoLinks('<p><a href="https://x.example/">x</a></p>'); } catch (e) { blocked = e; }
  check('送信前の確認: リンクが残っていれば止める', blocked && /リンクが残っています/.test(blocked.message), blocked && blocked.message);
  check('送信前の確認: リンクが無ければ通す（DOI の文字だけの本文）', (() => { try { render.assertNoLinks(html); return true; } catch (e) { return false; } })());

  // ---------- Bluesky ----------
  const longUrl = 'https://seda2026.wordpress.com/?p=' + '1'.repeat(10);
  const longEntry = { paper: entry.paper, article: { titleJa: 'とても長いタイトル'.repeat(20), intro: '紹介文です。'.repeat(40) } };
  const bs = render.buildBlueskyText(longEntry, longUrl);
  check('Bluesky: 長い紹介文とタイトルでも 292 字以内・URL とタグを残す',
        toGraphemes(bs).length <= render.BLUESKY.LIMIT - render.BLUESKY.RESERVE && bs.includes(longUrl) && bs.includes('#数学教育'),
        toGraphemes(bs).length);

  // ---------- RSS ----------
  const feed = '<rss><channel><item><title>【論文紹介】教師の専門性：教育実習生、現職教 員の検討</title>' +
               '<link>https://seda2026.wordpress.com/2026/09/24/%e3%80%90long/</link>' +
               '<guid isPermaLink="false">https://seda2026.wordpress.com/?p=123</guid></item></channel></rss>';
  check('RSS: WordPress がタイトルに挟んだ空白を無視して見つけ、短い URL（?p=）を使う',
        render.findInFeed(feed, '【論文紹介】教師の専門性：教育実習生、現職教員の検討') === 'https://seda2026.wordpress.com/?p=123');

  // ---------- 図の無い記事は投稿しない（写真は使わない） ----------
  const hasFig = (id) => id !== 'W-nofig-1' && id !== 'W-nofig-2';
  const pick1 = store.nextToPost(['W-nofig-1', 'W-with-1', 'W-with-2'], hasFig);
  check('投稿の選び方: 図のある、いちばん古い記事を選び、図の無い記事は飛ばす',
        pick1.id === 'W-with-1' && pick1.skipped.join() === 'W-nofig-1', JSON.stringify(pick1));
  const pick2 = store.nextToPost(['W-nofig-1', 'W-nofig-2'], hasFig);
  check('投稿の選び方: どれも図が無ければ null（投稿は失敗にして知らせる）', pick2.id === null && pick2.skipped.length === 2, JSON.stringify(pick2));
  check('投稿の選び方: 先頭に図があれば、飛ばさない', store.nextToPost(['W-with-1'], hasFig).skipped.length === 0);
  // 優先する記事（結果の欄に数値がある図）があれば先にする。古い順は、優先の中でも、そうでない中でも保つ
  const pref = (id) => id === 'W-with-2' || id === 'W-with-3';
  check('投稿の選び方: 優先する記事（結果に数値のある図）を先にし、その中は古い順',
        store.nextToPost(['W-with-1', 'W-with-2', 'W-with-3'], hasFig, pref).id === 'W-with-2');
  check('投稿の選び方: 優先する記事が無ければ、図のある古い順', store.nextToPost(['W-with-1', 'W-with-2'], hasFig, () => false).id === 'W-with-1');
  check('投稿の選び方: 優先する記事に図が無ければ、飛ばして次を選ぶ',
        store.nextToPost(['W-with-1', 'W-nofig-1'], hasFig, (id) => id === 'W-nofig-1').id === 'W-with-1');
  check('画像: Pixabay の部品は使わない（lib/pixabay.js が無い）', !fs.existsSync(path.join(__dirname, 'lib', 'pixabay.js')));


  // ---------- 研究の流れ図（論文の本文から、根拠の文を照合して作る） ----------
  const fig = require('./lib/figure');
  // 論文の本文（pdftotext の出力に似せて、改行・ハイフンでの語の分割を入れてある）
  const paperText = [
    'Method', 'Participants', 'A total of 145 fourth-grade students from three primary schools in Italy took part in the study.',
    'Measures', 'Working memory was assessed with the listening span task and the backward digit re-',
    'call task. Math anxiety was measured by the MARS-R questionnaire.',
    'Data analysis', 'Hierarchical multiple regression analyses were carried out. The model explained 21% of the variance (R2 = .21).',
    'References', 'Smith, J. (2000). An unrelated study of 999 students.'
  ].join('\n');
  const ctx = fig.makeContext(paperText);
  const good = (text, evidence) => ({ text, evidence });
  const okSpec = {
    target: [good('イタリアの/小学4年生145名', 'A total of 145 fourth-grade students from three primary schools in Italy')],
    conditions: [good('作業記憶', 'Working memory was assessed with the listening span task'), good('数学不安', 'Math anxiety was measured by the MARS-R questionnaire')],
    measures: [good('リスニングスパン課題', 'Working memory was assessed with the listening span task')],
    results: [good('階層的重回帰分析', 'Hierarchical multiple regression analyses were carried out'), good('説明率21%', 'The model explained 21% of the variance')]
  };
  check('図: 根拠の文が論文の本文にあり、数値が根拠の文にあれば合格', fig.validateSpec(okSpec, ctx).length === 0, fig.validateSpec(okSpec, ctx));
  const probs = (spec) => fig.validateSpec(spec, ctx).join(' / ');
  const withItem = (key, item) => ({ ...okSpec, [key]: [item] });
  check('図: 根拠の文が論文の本文に無ければ不合格（言い換え・作り話を通さない）',
        /本文にありません/.test(probs(withItem('conditions', good('作業記憶', 'Working memory was measured by a computerised battery of tests')))), probs(withItem('conditions', good('作業記憶', 'x'.repeat(30)))));
  check('図: 根拠の文は、改行とハイフンでの語の分割（re-/call）・空白・大文字小文字の違いを越えて一致する',
        fig.validateSpec(withItem('measures', good('逆唱課題', 'the backward digit recall task. math anxiety was measured')), ctx).length === 0);
  check('図: 参考文献リストにしか無い文は根拠にならない（参考文献は照合の範囲から除く）',
        /本文にありません/.test(probs(withItem('target', good('999名', 'An unrelated study of 999 students')))));
  check('図: 数値が根拠の文に無ければ不合格（根拠は本文にあっても、別の数値を書かせない）',
        /数値.*35.*根拠の文にありません/.test(probs(withItem('results', good('説明率35%', 'The model explained 21% of the variance')))), probs(withItem('results', good('説明率35%', 'The model explained 21% of the variance'))));
  check('図: 数値の和（145+145）も通さない',
        /290/.test(probs(withItem('target', good('小学4年生290名', 'A total of 145 fourth-grade students from three primary schools in Italy')))));
  check('図: 根拠の文が短すぎる・空なら不合格',
        /短すぎるか空/.test(probs(withItem('target', good('145名', 'in Italy')))) && /短すぎるか空/.test(probs(withItem('target', good('145名', '')))));
  const longItem = { ...okSpec, conditions: [good('あ'.repeat(config.figure.maxChars + 1), 'Working memory was assessed with the listening span task')] };
  const empty = { ...okSpec, measures: [] };
  const withUrl = { ...okSpec, conditions: [good('https://example.com/x', 'Working memory was assessed with the listening span task')] };
  check('図: 長すぎる項目・空の欄・URL は不合格',
        fig.validateSpec(longItem, ctx).length === 1 && fig.validateSpec(empty, ctx).length === 1 && fig.validateSpec(withUrl, ctx).length >= 1,
        [fig.validateSpec(longItem, ctx), fig.validateSpec(empty, ctx), fig.validateSpec(withUrl, ctx)]);
  // 照合に通らない項目は取り除き、残った項目で図を作る。どの欄も空にならなければ採用
  const mixed = { ...okSpec, conditions: [good('作業記憶', 'Working memory was assessed with the listening span task'), good('知能', 'Intelligence was assessed with Raven matrices in all children')] };
  const pruned = fig.pruneSpec(mixed, ctx);
  check('図: 照合に通らない項目（本文に無い「知能」）だけを取り除き、通る項目は残す',
        pruned.spec.conditions.length === 1 && pruned.spec.conditions[0].text === '作業記憶' && pruned.dropped.join() === '知能', JSON.stringify(pruned));
  // 「/」の位置で改行し、数値の照合と字数は「/」を除いた文字で行う
  const kana = (text) => fig.itemProblems(good(text, 'Working memory was assessed with the listening span task'), ctx).filter((p) => /切れ目|単語の途中/.test(p)).length;
  check('図: 「/」が単語の途中にあれば不合格。「/」が無く枠の幅でカタカナの語が切れる項目も不合格。切れない項目は合格',
        kana('相互教授法／生徒ファシリテー/ター・説明法') === 1 && kana('相互教授法／生徒ファシリテーター・説明法') === 1 && kana('インドネシアの公立高校生') === 0,
        [kana('相互教授法／生徒ファシリテー/ター・説明法'), kana('相互教授法／生徒ファシリテーター・説明法'), kana('インドネシアの公立高校生')]);
  check('図: 「/」の位置で改行し、数値の照合と字数は「/」を除いた文字で行う',
        fig.breakable('媒介効果が/全効果の62.98%') === '媒介効果が\\\\全効果の62.98\\%' && fig.plainItem('小学4年生/145名') === '小学4年生145名');
  check('図: LaTeX の特殊文字（% & _ # $）を逃がす', fig.texEscape('a%b&c_d#e$f') === 'a\\%b\\&c\\_d\\#e\\$f');
  const meta = { authors: ['Maria Chiara Passolunghi', 'Elisa Cargnelutti', 'Sandra Pellizzoni'], authorCount: 3, year: '2018' };
  check('図: 出典は「第一著者の姓 ら（年）」', fig.sourceNote(meta).startsWith('出典：Passolunghi ら（2018）。') && fig.sourceNote({ authors: ['A. One'], year: '2020' }).startsWith('出典：One（2020）。'), fig.sourceNote(meta));
  const tex = fig.buildTex(okSpec, meta);
  check('図: LaTeX は4つの欄の題と項目と出典を含み、欄の間に矢印が3本ある',
        ['対象', '条件・変数', '測定・手順', '分析と結果', 'イタリアの\\\\小学4年生145名', '階層的重回帰分析', 'Passolunghi'].every((t) => tex.includes(t)) && (tex.match(/\\draw\[arr\]/g) || []).length === 3);
  const nodeLines = tex.split('\n').filter((l) => /^\\node\[(t?box)\]/.test(l));
  check('図: 項目の枠（\\node）に「/」と根拠の文が出ず、「%」は \\% に逃がしてある',
        nodeLines.length === 6 && nodeLines.every((l) => !l.includes('/') && !/Hierarchical|Working memory/.test(l)) && nodeLines.some((l) => l.includes('説明率21\\%')), nodeLines.join(' | '));
  // 投稿のとき: 図があれば添付し、無ければ null（図の無い記事は投稿しない）
  const have = fig.loadFigureImage('W2755739173');
  check('図: images/<ID>.png があれば添付（PNG・ファイル名・出典）、無ければ null',
        have === null || (have.contentType === 'image/png' && have.buffer.slice(1, 4).toString() === 'PNG' && /^mathstat-w\d+\.png$/.test(have.filename) && have.credit === config.figure.credit));
  check('図: 無い ID は null（図の無い記事は投稿しない）', fig.loadFigureImage('W0000000000') === null);

  // 根拠の記録がある図だけを「根拠つき」とみなす（記事から作った古い図は作り直す）
  const grounded = { figure: { target: [good('a', 'x'.repeat(20))], conditions: [good('b', 'y'.repeat(20))], measures: [good('c', 'z'.repeat(20))], results: [good('d', 'w'.repeat(20))] } };
  const oldStyle = { figure: { target: ['小学4年生145名'], conditions: ['作業記憶'], measures: ['テスト'], results: ['回帰分析'] } };
  check('図: 根拠の文つきの項目だけの図は「根拠つき」。文字列だけの古い図・記録の無い図は違う',
        fig.isGrounded(grounded) === true && fig.isGrounded(oldStyle) === false && fig.isGrounded({}) === false && fig.isGrounded(null) === false);

  // 項目を作る流れ（言語モデルは偽物）: 1回目は本文に無い根拠 → 問題点を伝えて2回目で直す
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G' });
  const asks = [];
  fakeFetch((url, opts) => {
    if (!url.includes('generativelanguage')) return { status: 404 };
    const prompt = JSON.parse(opts.body).contents[0].parts.map((p) => p.text).join('\n');
    asks.push(prompt);
    const bad = asks.length === 1;
    const spec = {
      target: [good('小学4年生145名', bad ? 'Participants were 300 sixth graders from Spain' : 'A total of 145 fourth-grade students from three primary schools in Italy')],
      conditions: [good('作業記憶', 'Working memory was assessed with the listening span task')],
      measures: [good('MARS-R', 'Math anxiety was measured by the MARS-R questionnaire')],
      results: [good('階層的重回帰分析', 'Hierarchical multiple regression analyses were carried out')]
    };
    return geminiOk(spec);
  });
  const made = await fig.makeSpec({ paper: { title: 'T', venue: 'V', year: '2018' } }, paperText);
  check('図: 本文に無い根拠は直させ（2回目）、直れば採用する。問題点は次の依頼に書く',
        made && made.target[0].evidence.startsWith('A total of 145') && asks.length === 2 && /本文にありません/.test(asks[1]) &&
        asks[0].includes('A total of 145 fourth-grade') && !asks[0].includes('The model explained 99%'), JSON.stringify(made) + ' ' + asks.length);
  check('図: 依頼には論文の本文（参考文献は除く）を渡し、記事の文章は渡さない', asks[0].includes('Hierarchical multiple regression') && !asks[0].includes('An unrelated study of 999'));

  // 2回とも本文に無ければ、その項目を外す。欄が空になれば図は作らない
  llm.reset();
  const alwaysBad = { target: [good('小学4年生145名', 'Participants were 300 sixth graders from Spain')], conditions: okSpec.conditions, measures: okSpec.measures, results: okSpec.results };
  fakeFetch(() => geminiOk(alwaysBad));
  check('図: 2回とも根拠が本文に無く、欄が空になるなら null（作らない）', (await fig.makeSpec({ paper: { title: 'T' } }, paperText)) === null);

  // LaTeX が入っている環境（この PC）だけ、実際に描く
  const hasLatex = fs.existsSync(config.figure.lualatex) || (() => { try { require('child_process').execFileSync(config.figure.lualatex, ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
  if (hasLatex) {
    let png = null, errPng = null;
    try { png = fig.renderPng(okSpec, 'selftest', meta); } catch (e) { errPng = e; }
    check('図: LuaLaTeX で実際に描ける（PNG になり、横幅が 1000 px 以上）',
          png && png.slice(1, 4).toString() === 'PNG' && png.readUInt32BE(16) >= 1000, errPng && errPng.message);
  }

  // ---------- 台帳 ----------
  const ledger = { papers: {
    W1: { status: 'ready', createdAt: '2026-10-04 05:00', doi: '10.1/A' },
    W2: { status: 'ready', createdAt: '2026-10-03 05:00' },
    W3: { status: 'skipped' }, W4: { status: 'ready', createdAt: '2026-10-01 05:00' }
  } };
  check('投稿待ち: 作った順、送ったものと対象外は除く',
        store.queue(ledger, { W4: { wpSentAt: 'x' } }).join() === 'W2,W1');
  check('既知の判定: DOI の大文字小文字を問わない',
        store.isKnown(ledger, { id: 'W9', doi: '10.1/a' }) && !store.isKnown(ledger, { id: 'W9', doi: '10.1/b' }));

  // ---------- .env ----------
  const tmp = path.join(os.tmpdir(), 'mathstat-env-' + process.pid);
  fs.writeFileSync(tmp, String.fromCharCode(0xFEFF) + 'TEST_KEY_A=abc\r\nTEST_KEY_B="q v"\r\n');
  loadEnv(tmp);
  fs.unlinkSync(tmp);
  check('.env: 先頭の BOM と CRLF・引用符を扱う', process.env.TEST_KEY_A === 'abc' && process.env.TEST_KEY_B === 'q v');

  // ---------- 設定 ----------
  check('設定: 投稿先の置き場所を作る側と投稿する側で分けている', config.paths.ledger !== config.paths.posted);
}

run().then(() => {
  const ok = results.filter(Boolean).length;
  realLog(ok + ' / ' + results.length + ' OK' + (ok === results.length ? '' : '（NG ' + (results.length - ok) + '）'));
  if (ok !== results.length) process.exitCode = 1;
}).catch((e) => {
  console.error('テストが例外で止まりました: ' + (e.stack || e.message));
  process.exitCode = 1;
});
