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

  // ---------- 言語モデルの順番（2026-10-11 ユーザー指示）----------
  // 1番目: Ollama（.62）→ 2番目: LM Studio（.16:1234）→ 3番目: 外部 API（Gemini → Claude）。
  // 偽のサーバーを、起動している／していないで切り替えながら確かめる
  const OLLAMA = new URL(config.ollama.host).host;
  const LMSTUDIO = new URL(config.lmstudio.host).host;
  // 本物の設定はモデル名を明示してある（実測で選んだ）。テストでは、偽サーバーのモデル名で「空の設定（自動）」の動きを確かめる
  const realLmModels = config.lmstudio.models;
  config.lmstudio.models = [];
  const OLLAMA_MODELS = { body: { models: [{ name: 'gemma4:12b' }, { name: 'qwen3.5:9b' }, { name: 'shosetsu:latest' }] } };
  const LM_MODELS = { body: { data: [{ id: 'lm-model-a' }, { id: 'text-embedding-x' }, { id: 'lm-model-b' }, { id: 'lm-model-c' }] } };
  // 空の文字列は、本物のサーバーが「空の応答」を返したときと同じように、そのまま空で返す
  const asJson = (obj) => (obj === '' ? '' : JSON.stringify(obj));
  /**
   * 3種類のサーバーを偽物にする。up は起動しているもの。reply は各サーバーが返す JSON。
   * 起動していなければ、本物と同じように接続できない（ECONNREFUSED）
   */
  function servers({ up = ['ollama', 'lmstudio', 'gemini'], ollama = { ok: 1 }, lmstudio = { ok: 2 }, gemini = null, loaded = {}, unloadOnce = false } = {}) {
    // LM Studio の読み込み状態。loaded は {モデル: 文脈の長さ}（無ければ未読み込み）。
    // unloadOnce が true なら、最初の会話の要求は「途中でほかの用途にアンロードされた」ことにする
    const lmState = { loaded: { ...loaded }, loads: [], unloads: [], dropped: false };
    const seen = { ollama: [], lmstudio: [], gemini: [], lm: lmState };
    const calls = fakeFetch((url, opts) => {
      const u = new URL(url);
      if (u.host === OLLAMA) {
        if (!up.includes('ollama')) throw new Error('connect ECONNREFUSED');
        if (u.pathname === '/api/tags') return OLLAMA_MODELS;
        const b = JSON.parse(opts.body);
        seen.ollama.push(b);
        return { body: { message: { content: asJson(typeof ollama === 'function' ? ollama(b) : ollama) }, done_reason: 'stop' } };
      }
      if (u.host === LMSTUDIO) {
        if (!up.includes('lmstudio')) throw new Error('connect ECONNREFUSED');
        if (u.pathname === '/v1/models') return LM_MODELS;
        if (u.pathname === '/api/v1/models') {
          return { body: { models: LM_MODELS.body.data.map((m) => ({ key: m.id, type: /embed/.test(m.id) ? 'embedding' : 'llm',
            loaded_instances: lmState.loaded[m.id] ? [{ id: m.id, config: { context_length: lmState.loaded[m.id] } }] : [] })) } };
        }
        if (u.pathname === '/api/v1/models/unload') {
          const b = JSON.parse(opts.body);
          lmState.unloads.push(b.instance_id);
          delete lmState.loaded[b.instance_id];
          return { body: { instance_id: b.instance_id } };
        }
        if (u.pathname === '/api/v1/models/load') {
          const b = JSON.parse(opts.body);
          lmState.loads.push(b);
          lmState.loaded[b.model] = b.context_length;
          return { body: { type: 'llm', instance_id: b.model, status: 'loaded' } };
        }
        const b = JSON.parse(opts.body);
        if (unloadOnce && !lmState.dropped) {
          lmState.dropped = true;
          delete lmState.loaded[b.model];
          return { status: 400, body: { error: 'Model unloaded by user or API request.' } };
        }
        // 読み込み済みの文脈より長い入力は、本物と同じ 400 にする（約 4 文字 = 1 トークンとして数える）
        const tokens = JSON.stringify(b.messages).length / 4;
        if (lmState.loaded[b.model] && tokens > lmState.loaded[b.model]) {
          return { status: 400, body: { error: 'request (' + Math.round(tokens) + ' tokens) exceeds the available context size (' + lmState.loaded[b.model] + ' tokens)' } };
        }
        seen.lmstudio.push(b);
        return { body: { choices: [{ message: { content: asJson(typeof lmstudio === 'function' ? lmstudio(b) : lmstudio) }, finish_reason: 'stop' }], usage: {} } };
      }
      if (url.includes('generativelanguage')) {
        if (!up.includes('gemini')) return BUSY;
        seen.gemini.push(JSON.parse(opts.body));
        return geminiOk(typeof gemini === 'function' ? gemini() : (gemini || { ok: 3 }));
      }
      return { status: 404 };
    });
    return { calls, seen };
  }
  const SCHEMA_OK = { type: 'OBJECT', properties: { ok: { type: 'INTEGER' } } };
  const claudeSeen = [];
  fakeClaude({ ok: 4 }, claudeSeen);

  check('設定: LM Studio のモデルは、実測で選んだものを明示している（未測定のモデルを自動で使わない）',
        realLmModels.join() === 'google/gemma-4-12b-qat,google/gemma-4-26b-a4b-qat' && !/embed/.test(realLmModels.join()), realLmModels.join());
  check('設定: 文脈の長さは論文の全文（約1.5万トークン）が入る大きさ以上で、考える機能は切る',
        config.lmstudio.contextLength >= 30000 && config.lmstudio.reasoningEffort === 'none');

  // 全部起動していれば、1番目の Ollama（先頭のモデル）が答える。ほかは呼ばない
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  let s1 = servers();
  let out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('順番: 全部起動していれば、1番目の Ollama の先頭のモデル（gemma4:12b）が答え、ほかは呼ばない',
        out.ok === 1 && llm.usedModel() === 'gemma4:12b' && s1.seen.ollama.length === 1 && s1.seen.ollama[0].model === 'gemma4:12b' &&
        s1.seen.lmstudio.length === 0 && s1.seen.gemini.length === 0 && claudeSeen.length === 0, JSON.stringify([out, llm.usedModel()]));
  check('Ollama には think: false・スキーマ（format）・num_ctx を渡す',
        s1.seen.ollama[0].think === false && s1.seen.ollama[0].format.additionalProperties === false && s1.seen.ollama[0].options.num_ctx === config.ollama.composeNumCtx);
  check('Ollama の shosetsu（小説用）は、設定に無いので使わない', !s1.calls.some((c) => c.opts.body && /shosetsu/.test(c.opts.body)));

  // 1番目が起動していなければ、2番目の LM Studio が答える
  llm.reset();
  s1 = servers({ up: ['lmstudio', 'gemini'] });
  out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('順番: 1番目（Ollama）が起動していなければ、2番目の LM Studio が答える',
        out.ok === 2 && llm.usedModel() === 'lm-model-a' && s1.seen.lmstudio.length === 1 && s1.seen.gemini.length === 0, JSON.stringify([out, llm.usedModel()]));
  check('LM Studio には OpenAI 互換の形（messages・response_format の json_schema）で頼み、鍵は付けない',
        s1.seen.lmstudio[0].response_format.type === 'json_schema' && s1.seen.lmstudio[0].response_format.json_schema.schema.additionalProperties === false &&
        s1.seen.lmstudio[0].messages[0].role === 'user');
  check('LM Studio のモデルは、設定が空なら返された順に（埋め込み用は除き）最大 autoMax 個だけ',
        (await llm.candidates()).filter((c) => /^LM Studio/.test(c.label)).map((c) => c.label).join() === 'LM Studio lm-model-a,LM Studio lm-model-b');

  // LM Studio は共用サーバー。要求時に自動で読み込まれるモデルの文脈は 8,192 で、論文の全文が入らない（2026-10-11 の実機）
  const bigPrompt = [{ text: 'x'.repeat(4 * (config.lmstudio.contextLength - 2000)) }];   // 約 38,000 トークン
  llm.reset();
  s1 = servers({ up: ['lmstudio'], ollama: null });
  out = await llm.generateJson(bigPrompt, SCHEMA_OK);
  check('LM Studio: 未読み込みのモデルは、文脈の長さ（40960）を指定して読み込んでから使う。アンロードは呼ばない',
        out.ok === 2 && s1.seen.lm.loads.length === 1 && s1.seen.lm.loads[0].model === 'lm-model-a' &&
        s1.seen.lm.loads[0].context_length === config.lmstudio.contextLength && s1.seen.lm.unloads.length === 0, JSON.stringify([out, s1.seen.lm.loads]));
  check('LM Studio: 考える機能を切る（reasoning_effort: none。付けないと本文が空になる）',
        s1.seen.lmstudio[0].reasoning_effort === 'none');

  llm.reset();
  s1 = servers({ up: ['lmstudio'], loaded: { 'lm-model-a': 65536 } });
  out = await llm.generateJson(bigPrompt, SCHEMA_OK);
  check('LM Studio: 読み込み済みで文脈が足りるモデルは、読み込み直さずにそのまま使う',
        out.ok === 2 && s1.seen.lm.loads.length === 0 && s1.seen.lmstudio.length === 1);

  // 読み込み済みで文脈が足りないモデルは、ほかの用途で使っているかもしれないので入れ替えず、次の候補へ回る
  llm.reset();
  s1 = servers({ up: ['lmstudio', 'gemini'], loaded: { 'lm-model-a': 8192, 'lm-model-b': 8192 } });
  out = await llm.generateJson(bigPrompt, SCHEMA_OK);
  check('LM Studio: 読み込み済みで文脈が足りないモデル（8192）は、入れ替えず（load もしない）飛ばし、次の候補（Gemini）へ回る',
        out.ok === 3 && s1.seen.lm.loads.length === 0 && s1.seen.lmstudio.length === 0 && s1.seen.gemini.length === 1 && s1.seen.lm.loaded['lm-model-a'] === 8192,
        JSON.stringify([out, s1.seen.lm.loads, s1.seen.lm.loaded]));

  // 要求の途中で、ほかの用途にアンロードされたら、1回だけ読み込み直して再試行する
  llm.reset();
  s1 = servers({ up: ['lmstudio'], loaded: { 'lm-model-a': 65536 }, unloadOnce: true });
  out = await llm.generateJson(bigPrompt, SCHEMA_OK);
  check('LM Studio: 要求の途中で「Model unloaded」になったら、1回だけ読み込み直して再試行する',
        out.ok === 2 && s1.seen.lm.dropped === true && s1.seen.lm.loads.length === 1 && s1.seen.lmstudio.length === 1, JSON.stringify([out, s1.seen.lm.loads]));

  // 後片づけ: この実行で自分が読み込んだモデルだけを外す。もともと読み込まれていたもの（ほかの用途）は触らない
  llm.reset();
  s1 = servers({ up: ['lmstudio'], loaded: { 'lm-model-b': 65536 }, unloads: true });
  out = await llm.generateJson(bigPrompt, SCHEMA_OK);                    // lm-model-a を自分で読み込む
  check('LM Studio: 自分で読み込んだモデルを記録する', llm.state.lmstudioLoaded.join() === 'lm-model-a', llm.state.lmstudioLoaded.join());
  await llm.lmstudioRelease();
  check('LM Studio: 実行の最後に、自分で読み込んだモデルだけをアンロードし、もともと読み込まれていたモデル（lm-model-b）は触らない',
        s1.seen.lm.unloads.join() === 'lm-model-a' && s1.seen.lm.loaded['lm-model-b'] === 65536 && llm.state.lmstudioLoaded.length === 0,
        JSON.stringify([s1.seen.lm.unloads, s1.seen.lm.loaded]));
  llm.reset();
  s1 = servers({ up: ['lmstudio'], loaded: { 'lm-model-a': 65536 }, unloads: true });
  await llm.generateJson(bigPrompt, SCHEMA_OK);                          // もともと読み込まれていたモデルを使うだけ
  await llm.lmstudioRelease();
  check('LM Studio: もともと読み込まれていたモデルを使っただけなら、何もアンロードしない', s1.seen.lm.unloads.length === 0 && s1.seen.lm.loaded['lm-model-a'] === 65536);

  // 手元の2台とも起動していなければ、3番目の外部 API（Gemini）
  llm.reset();
  s1 = servers({ up: ['gemini'] });
  out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('順番: 手元の2台が起動していなければ、3番目の外部 API（Gemini）が答える',
        out.ok === 3 && s1.seen.gemini.length === 1 && s1.seen.ollama.length === 0 && s1.seen.lmstudio.length === 0 && claudeSeen.length === 0);

  // Gemini も使えなければ Claude（最後）
  llm.reset();
  s1 = servers({ up: [] });
  out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('順番: Gemini も使えなければ、最後に Claude（構造化出力の指定つき）',
        out.ok === 4 && llm.usedModel() === config.claude.model && claudeSeen[0].output_config.format.type === 'json_schema');

  // 候補の並び（Ollama のモデル2つ → LM Studio のモデル → Gemini → Claude）
  llm.reset();
  servers();
  check('候補の並び: Ollama（gemma4・qwen3.5）→ LM Studio（2つ）→ Gemini → Claude',
        (await llm.candidates()).map((c) => c.label).join(' | ') ===
        'Ollama gemma4:12b | Ollama qwen3.5:9b | LM Studio lm-model-a | LM Studio lm-model-b | Gemini | Claude');

  // 先頭のモデルが空の応答 → 同じ Ollama の次のモデル（qwen3.5:9b）→ それも駄目なら次の提供元
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  s1 = servers({ ollama: (b) => (b.model === 'gemma4:12b' ? '' : { ok: 11 }) });
  out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('先頭のモデル（gemma4:12b）が空の応答なら、同じ Ollama の次のモデル（qwen3.5:9b）で答える',
        out.ok === 11 && llm.usedModel() === 'qwen3.5:9b' && s1.seen.ollama.map((b) => b.model).join() === 'gemma4:12b,qwen3.5:9b' && s1.seen.lmstudio.length === 0,
        JSON.stringify([out, llm.usedModel()]));
  llm.reset();
  s1 = servers({ ollama: () => '' });
  out = await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  check('Ollama のモデルが全部空の応答なら、2番目の LM Studio に回る', out.ok === 2 && s1.seen.ollama.length === 2 && s1.seen.lmstudio.length === 1, JSON.stringify(out));

  // 一度届かなかった提供元は、その実行では飛ばす（一覧は1回だけ取る）
  llm.reset();
  s1 = servers({ up: ['gemini'] });
  await llm.generateJson([{ text: 'x' }], SCHEMA_OK);
  const before = s1.calls.length;
  await llm.generateJson([{ text: 'y' }], SCHEMA_OK);
  const ollamaTries = s1.calls.filter((c) => new URL(c.url).host === OLLAMA).length;
  check('届かない手元のサーバーは、その実行では1回しか確かめない（毎回待たない）', ollamaTries === 1, ollamaTries);

  // 全部使えない → 論文の失敗に数えないエラー（試した順を書く）
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G' });
  s1 = servers({ up: [] });
  let err = null;
  try { await llm.generateJson([{ text: 'x' }], { type: 'OBJECT' }); } catch (e) { err = e; }
  check('どれも使えなければ、論文の失敗に数えないエラー', err && err.transient && /Gemini/.test(err.message), err && err.message);

  // 外部 API だけを止める（--only-local）
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  llm.state.noExternal = true;
  s1 = servers({ up: [] });
  err = null;
  try { await llm.generateJson([{ text: 'x' }], { type: 'OBJECT' }); } catch (e) { err = e; }
  check('--only-local（外部 API を使わない）なら、手元が使えなくても Gemini・Claude を呼ばない',
        err && err.transient && s1.seen.gemini.length === 0, err && err.message);
  llm.reset();

  // Gemini の鍵の誤り（401）は次へ回さずに投げる
  setEnv({ GEMINI_API_KEY: 'G' });
  fakeFetch((url) => {
    const host = new URL(url).host;
    if (host === OLLAMA || host === LMSTUDIO) throw new Error('connect ECONNREFUSED');
    return { status: 401, body: { error: { message: 'API key not valid' } } };
  });
  err = null;
  try { await llm.generateJson([{ text: 'x' }], { type: 'OBJECT' }); } catch (e) { err = e; }
  check('Gemini の鍵の誤り（401）は、手元が使えないときも隠さず、原因が分かる形で知らせる', err && /401/.test(err.message), err && err.message);

  // 手元で一度 Gemini が全滅したら、その実行では Gemini を飛ばす
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  s1 = servers({ up: [] });
  await llm.generateJson([{ text: 'x' }], SCHEMA_OK);       // Gemini が全モデル混雑 → Claude が答える
  const gem1 = s1.calls.filter((c) => c.url.includes('generativelanguage')).length;
  s1.calls.length = 0;
  const out2 = await llm.generateJson([{ text: 'y' }], SCHEMA_OK);
  check('一度 Gemini が全滅したら、その実行では Gemini を飛ばす（全モデル×2回×巡回数を使い切ったあと）',
        out2.ok === 4 && gem1 === config.geminiModels.length * 2 * config.geminiRounds && !s1.calls.some((c) => c.url.includes('generativelanguage')), [gem1, s1.calls.length]);

  // ---------- 記事の執筆 ----------
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

  // 記事の執筆の流れ（順番は上の「言語モデルの順番」と同じ。手元のモデルの記事は確かめてから使う）
  const paperFull = PAPER_TEXT;
  const classifyReply = (yes = true) => ({ aboutMathLearning: yes, quantitativeStatistics: yes, brainImagingIsMainTopic: false, explainsStatisticalMethodOnly: false, qualitativeOnly: false });
  /** 記事を頼まれたら article を、テーマの質問（aboutMathLearning を含む）には classify を返す */
  const writerServer = (article, classify = classifyReply(), extra = {}) => (b) => {
    const asked = (b.format && b.format.properties && b.format.properties.aboutMathLearning) || (b.response_format && b.response_format.json_schema.schema.properties.aboutMathLearning);
    return asked ? classify : article;
  };

  // 1. 1番目の Ollama（gemma4）が全文を読んで書く。テーマは問いを分けた答えで決める。外部 API は呼ばない
  llm.reset();
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });
  claudeSeen.length = 0;
  let w = servers({ ollama: writerServer(rawArticle('145')) });
  const a1 = await writer.writeArticle(PAPER, paperFull, READINGS);
  const writing1 = w.seen.ollama.filter((b) => !(b.format.properties && b.format.properties.aboutMathLearning));
  check('記事: 1番目の Ollama（gemma4:12b）が全文を1回で読んで書く（num_ctx は全文の大きさ・think: false）。外部 API は呼ばない',
        a1.model === 'gemma4:12b' && writing1.length === 1 && writing1[0].options.num_ctx === config.ollama.fullTextNumCtx && writing1[0].think === false &&
        writing1[0].messages[0].content.includes('Working memory was measured') && w.seen.gemini.length === 0 && claudeSeen.length === 0,
        a1.model + ' ' + writing1.length);

  // 2. 数値が論文に無ければ、その候補の記事は使わず、次の候補（同じ Ollama の qwen3.5）で書き直す
  llm.reset();
  w = servers({ ollama: (b) => writerServer(b.model === 'gemma4:12b' ? rawArticle('999') : rawArticle('145'))(b) });
  const a2 = await writer.writeArticle(PAPER, paperFull, READINGS);
  check('記事: 手元の記事に論文に無い数値（999）があれば使わず、次の候補（qwen3.5:9b）で書き直す。外部 API は呼ばない',
        a2.model === 'qwen3.5:9b' && /145名/.test(a2.sections.what) && w.seen.gemini.length === 0 && claudeSeen.length === 0, a2.model);

  // 3. 手元のモデルが全部、数値が合わなければ、2番目の LM Studio → それも合わなければ Gemini（外部 API）
  llm.reset();
  w = servers({ ollama: writerServer(rawArticle('999')), lmstudio: writerServer(rawArticle('999')), gemini: rawArticle('145') });
  const a3 = await writer.writeArticle(PAPER, paperFull, READINGS);
  check('記事: 手元の候補（Ollama 2つ・LM Studio 2つ）がどれも数値が合わなければ、3番目の外部 API（Gemini）で書く',
        a3.model === llm.usedModel() && /145名/.test(a3.sections.what) && w.seen.ollama.length >= 4 && w.seen.lmstudio.length >= 2 && w.seen.gemini.length >= 1,
        [a3.model, w.seen.ollama.length, w.seen.lmstudio.length, w.seen.gemini.length]);

  // 4. 手元が使えない日は、Gemini が書く（手元用の質問式のテーマ判定は呼ばない）
  llm.reset();
  w = servers({ up: ['gemini'], gemini: rawArticle('145') });
  const a4 = await writer.writeArticle(PAPER, paperFull, READINGS);
  check('記事: 手元の2台が起動していなければ、Gemini が書く（外部の記事に質問式の判定は付けない）',
        /145名/.test(a4.sections.what) && w.seen.ollama.length === 0 && w.seen.lmstudio.length === 0 && w.seen.gemini.length === 1 &&
        a4.relevanceReason === '算数の量的研究', JSON.stringify([a4.relevanceReason, w.seen.gemini.length]));

  // 5. Gemini も使えなければ Claude（最後）
  llm.reset();
  claudeSeen.length = 0;
  fakeClaude(rawArticle('145'), claudeSeen);
  w = servers({ up: [] });
  const a5 = await writer.writeArticle(PAPER, paperFull, READINGS);
  check('記事: 手元も Gemini も使えなければ、最後に Claude が書く', a5.model === config.claude.model && claudeSeen.length === 1, a5.model);
  fakeClaude({ ok: 4 }, claudeSeen);

  // 6. テーマの判定は、記事を書かせた回の relevant ではなく、問いを分けた答えで決める（脳画像が中心 → テーマ外）
  for (const [brain, want] of [[false, true], [true, false]]) {
    llm.reset();
    const verdict = { ...classifyReply(), brainImagingIsMainTopic: brain };
    servers({ ollama: writerServer({ ...rawArticle('145'), relevant: false }, verdict) });
    const a6 = await writer.writeArticle(PAPER, paperFull, READINGS);
    check('記事: テーマの判定は問いを分けた答えで決める（脳画像が中心=' + brain + ' → ' + (want ? '記事にする' : 'テーマ外') + '）',
          a6.relevant === want && (want || /脳画像/.test(a6.relevanceReason)), a6.relevant + ' ' + a6.relevanceReason);
  }

  // 7. どの候補でも書けなければ、論文の失敗に数えないエラー（試した順を書く）
  llm.reset();
  setEnv({});
  servers({ up: [] });
  let werr = null;
  try { await writer.writeArticle(PAPER, paperFull, READINGS); } catch (e) { werr = e; }
  check('記事: どの候補でも書けなければ、論文の失敗に数えないエラー', werr && werr.transient && /言語モデル/.test(werr.message), werr && werr.message);
  setEnv({ GEMINI_API_KEY: 'G', ANTHROPIC_API_KEY: 'A' });

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
