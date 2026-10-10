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
    intro: '数学不安は文章題に関わるのでしょうか。', imageQuery: 'math anxiety 数学'
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
  check('整える: 鉤括弧を外す・範囲外の番号と本文に無い用語を落とす・写真の検索語は英字だけ',
        art.titleJa === '数学不安と文章題' && art.nextReads.length === 1 && art.terms.length === 1 &&
        art.imageQuery === 'math anxiety', JSON.stringify([art.titleJa, art.nextReads.length, art.terms, art.imageQuery]));

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

  // ---------- 写真（Pixabay） ----------
  const pixabay = require('./lib/pixabay');
  const hitOf = (tags, user) => ({ tags, user, largeImageURL: 'https://cdn.example/' + user + '.jpg', webformatURL: 'https://cdn.example/s-' + user + '.jpg', pageURL: 'https://pixabay.com/photos/' + user + '/' });
  process.env.PIXABAY_API_KEY = 'PK';
  const asked = [];
  fakeFetch((url) => {
    const q = new URL(url).searchParams.get('q');
    asked.push(q);
    if (q === 'child math number line') return { body: { hits: [hitOf('heart, couple, together, love', 'couple'), hitOf('child, boy, summer', 'boy')] } };
    if (q === 'mathematics classroom') return { body: { hits: [hitOf('mathematics, school, blackboard', 'board')] } };
    if (q === 'students in class') return { body: { hits: [hitOf('heart, couple', 'couple'), hitOf('students, classroom, learning', 'class')] } };
    return { body: { hits: [] } };
  });
  const ph1 = await pixabay.findPhoto('students in class');
  check('写真: タグが話題に合うものだけから選ぶ（カップルは選ばない）', ph1 && ph1.user === 'class', JSON.stringify(ph1));
  asked.length = 0;
  const ph2 = await pixabay.findPhoto('child math number line');
  check('写真: 検索語の写真が話題に合わなければ、次の検索語（mathematics classroom）で探す',
        ph2 && ph2.user === 'board' && asked.join() === 'child math number line,mathematics classroom', JSON.stringify([ph2, asked]));
  fakeFetch(() => ({ body: { hits: [hitOf('heart, couple', 'couple')] } }));
  check('写真: どれも話題に合わなければ、写真なしにする（合わない写真を付けない）', (await pixabay.findPhoto('x')) === null);
  fakeFetch(() => ({ body: { hits: [{ largeImageURL: 'https://cdn.example/n.jpg', user: 'n' }] } }));
  check('写真: tags の項目が無い応答は、写真を付ける（仕様変更で写真が出なくなるのを避ける）', (await pixabay.findPhoto('x')).user === 'n');
  delete process.env.PIXABAY_API_KEY;

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
