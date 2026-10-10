/**
 * 言語モデルの呼び出し
 *
 * どれも「parts（{text} の配列）とスキーマを渡すと、パース済みの JSON が返る」形にそろえてある。
 * スキーマは Gemini の書き方（type が 'OBJECT' などの大文字）で書き、そのほかには toJsonSchema で直す。
 *
 * 順番（2026-10-11 ユーザー指示。手元の2台を先にし、外部 API は2台が使えないときの第3候補）:
 *   1. Ollama（config.ollama.host、既定 http://192.168.128.62:11434）。入っているモデルを config.ollama.models の順に
 *   2. LM Studio など OpenAI 互換の API（config.lmstudio.host、既定 http://192.168.128.16:1234）
 *   3. 外部 API: Gemini（無料。混雑・上限なら次のモデルへ、全部駄目なら少し待って巡り直す）→ Claude（従量課金。鍵があるときだけ）
 * 手元の2台は、届かなければ（起動していなければ）その実行のあいだは飛ばす。
 *
 * **一度全滅した提供元は、その実行のあいだは飛ばす**（CLAUDE.md の決まり）。
 * GAS 版で、本文を Claude で書いたあと字数の書き直しと用語確認でまた Gemini を巡り、2分を無駄にした（2026-09-24）。
 */
const { fetchRetry, httpError, hasEnv, sleep } = require('./http');
const config = require('../config');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

const state = { geminiDown: false, ollamaModels: null, lmstudioModels: null, lmstudioLoaded: [], noExternal: false, noLmstudio: false, lastModel: '' };
const usedModel = () => state.lastModel;

/** テストで状態を戻すため */
function reset() {
  state.geminiDown = false;
  state.ollamaModels = null;
  state.lmstudioModels = null;
  state.lmstudioLoaded = [];
  state.noExternal = false;
  state.noLmstudio = false;
  state.lastModel = '';
}

// ============================================================
// スキーマ
// ============================================================

/**
 * Gemini のスキーマを JSON Schema に直す。オブジェクトは additionalProperties: false、項目はすべて必須
 * （Claude の構造化出力の決まり。Ollama もこの形で受け付ける）
 */
function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { type: String(s.type || '').toLowerCase() };
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.properties) {
    out.properties = {};
    Object.keys(s.properties).forEach((k) => { out.properties[k] = toJsonSchema(s.properties[k]); });
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  } else if (out.type === 'object') {
    out.additionalProperties = false;
  }
  return out;
}

function parseJson(text, label) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(t);
  } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* 下で投げる */ }
    }
    throw new Error(label + ' の応答が JSON ではありません: ' + t.slice(0, 300));
  }
}

// ============================================================
// Gemini
// ============================================================

function isBusy(status) {
  return status === 503 || status === 429 || status === 404 || status >= 500;
}

function callGemini(model, parts, schema) {
  const generationConfig = {
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    responseMimeType: 'application/json'
  };
  if (schema) generationConfig.responseSchema = schema;

  return fetchRetry(GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY.trim() },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
  }, {
    attempts: 2,
    timeoutMs: 180000,
    // 1日の上限は待っても戻らない。1分あたりの上限と混雑だけ待つ
    shouldRetry: async (r) => {
      if (r.ok) return false;
      if (r.status === 429) return !/PerDay|per day/i.test(await r.clone().text());
      return r.status === 503 || r.status >= 500;
    }
  });
}

/** 全モデルを1巡する。通ったら JSON、全部混雑なら null、それ以外の失敗は投げる */
async function geminiOnce(parts, schema) {
  const models = config.geminiModels;
  let res = null;
  for (let i = 0; i < models.length; i++) {
    res = await callGemini(models[i], parts, schema);
    // スキーマを受け付けない条件では 400 が返る。スキーマなしでもう一度（JSON で返す指定は残る）
    if (res.status === 400 && schema) {
      console.warn('  400 が返ったため、スキーマなしで試します: ' + (await res.clone().text()).slice(0, 200));
      res = await callGemini(models[i], parts, null);
    }
    if (res.ok) {
      const json = await res.json();
      const cand = (json.candidates || [])[0];
      if (!cand) throw new Error('Gemini の応答に候補がありません: ' + JSON.stringify(json).slice(0, 200));
      if (cand.finishReason && cand.finishReason !== 'STOP') {
        throw new Error('Gemini が生成を完了しませんでした: ' + cand.finishReason);
      }
      state.lastModel = models[i];
      return parseJson(((cand.content || {}).parts || []).map((p) => p.text || '').join(''), 'Gemini');
    }
    if (!isBusy(res.status)) throw await httpError('Gemini APIエラー', res);
    if (i < models.length - 1) console.warn(`  ${models[i]} が使えないため ${models[i + 1]} に切り替えます（${res.status}）`);
  }
  console.warn('  Gemini は全モデルが使えません（最後: ' + res.status + '）');
  return null;
}

async function gemini(parts, schema) {
  if (state.geminiDown || !hasEnv('GEMINI_API_KEY')) return null;
  for (let round = 1; round <= config.geminiRounds; round++) {
    const out = await geminiOnce(parts, schema);
    if (out) return out;
    if (round < config.geminiRounds) {
      console.warn(`  ${Math.round(config.geminiRoundWaitMs / 1000)}秒おいて Gemini を巡り直します（${round}/${config.geminiRounds}）`);
      await sleep(config.geminiRoundWaitMs);
    }
  }
  state.geminiDown = true;
  console.warn('  この実行では、ここから先 Gemini を使いません。');
  return null;
}

// ============================================================
// Ollama（1番目）
// ============================================================

/**
 * Ollama に入っているモデルの一覧を、1回の実行で1度だけ取る。届かなければ空の一覧
 * （届かない原因は、この PC とそのサーバーのネットワーク。GitHub Actions からは届かない）
 */
async function ollamaInstalled() {
  if (state.ollamaModels) return state.ollamaModels;
  try {
    const res = await fetch(config.ollama.host + '/api/tags', { signal: AbortSignal.timeout(5000) });
    state.ollamaModels = res.ok ? ((await res.json()).models || []).map((m) => m.name) : [];
  } catch (e) {
    console.warn('  Ollama（' + config.ollama.host + '）に届きません: ' + e.message);
    state.ollamaModels = [];
  }
  return state.ollamaModels;
}

/** 設定したモデルのうち、実際に入っているもの（使う順） */
async function ollamaUsableModels() {
  const have = await ollamaInstalled();
  return (config.ollama.models || []).filter((m) => have.includes(m));
}

/**
 * Ollama に1回問い合わせる。失敗したら投げる。
 * think: false を必ず付ける。Qwen3.5・Gemma4 は既定で「考える」ので、出力の枠を考えるだけで使い切り、
 * 本文が空になった（2026-10-04、300トークンで content が空）
 */
async function ollamaChat(prompt, schema, opts = {}) {
  const started = Date.now();
  const model = opts.model || config.ollama.models[0];
  const res = await fetch(config.ollama.host + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: schema ? toJsonSchema(schema) : undefined,
      options: { num_ctx: opts.numCtx || config.ollama.numCtx, temperature: config.temperature },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(config.ollama.timeoutMs)
  });
  if (!res.ok) throw await httpError('Ollama エラー', res);
  const json = await res.json();
  console.log(`  Ollama ${model} ${((Date.now() - started) / 1000).toFixed(0)}秒（入力 ${json.prompt_eval_count} / 出力 ${json.eval_count} トークン）`);
  if (json.done_reason === 'length') throw new Error('Ollama が途中で止まりました（num_ctx が足りない可能性）');
  const text = (json.message || {}).content || '';
  if (!text.trim()) throw new Error('Ollama の応答が空でした（' + model + '）');
  state.lastModel = model;
  return schema ? parseJson(text, 'Ollama') : text;
}

// ============================================================
// LM Studio など OpenAI 互換の API（2番目）
// ============================================================

/**
 * 使えるモデルの一覧を、1回の実行で1度だけ取る。届かなければ（起動していなければ）空の一覧。
 * config.lmstudio.models が空なら、サーバーが返すモデルを順に使う（埋め込み用は除く）
 */
async function lmstudioInstalled() {
  if (state.lmstudioModels) return state.lmstudioModels;
  const cfg = config.lmstudio;
  try {
    const res = await fetch(cfg.host + '/v1/models', { signal: AbortSignal.timeout(5000) });
    const have = res.ok ? ((await res.json()).data || []).map((m) => m.id).filter((id) => !/embed/i.test(id)) : [];
    const wanted = (cfg.models || []).length ? cfg.models.filter((m) => have.includes(m)) : have.slice(0, cfg.autoMax);
    state.lmstudioModels = wanted;
  } catch (e) {
    console.warn('  LM Studio（' + cfg.host + '）に届きません（起動していないときは、次の候補へ回します）: ' + e.message);
    state.lmstudioModels = [];
  }
  return state.lmstudioModels;
}

/**
 * 使う前に、モデルが十分な文脈で読み込まれているかを確かめ、足りなければ読み込む。足りなければ投げる（次の候補へ回る）。
 *   ・未読み込み → POST /api/v1/models/load で context_length を指定して読み込む
 *   ・読み込み済みで文脈が足りる → そのまま使う
 *   ・読み込み済みで文脈が足りない → ほかの用途で使われているかもしれないので、アンロードしない。この候補は飛ばす
 * LM Studio は共用サーバー。要求時に自動で読み込まれるモデルの文脈は 8,192 で、論文の全文が入らない（2026-10-11 の実機）
 */
async function lmstudioEnsureLoaded(model) {
  const cfg = config.lmstudio;
  const need = cfg.contextLength;
  const list = await (await fetch(cfg.host + '/api/v1/models', { signal: AbortSignal.timeout(8000) })).json();
  const info = (list.models || []).find((m) => m.key === model);
  if (!info) throw new Error('LM Studio にモデル ' + model + ' がありません');
  const inst = (info.loaded_instances || [])[0];
  if (inst) {
    const have = (inst.config || {}).context_length || 0;
    if (have >= need) return;
    throw new Error('LM Studio の ' + model + ' はすでに文脈 ' + have + ' で読み込まれています（足りないが、ほかの用途で使っているかもしれないので、入れ替えません）');
  }
  const res = await fetch(cfg.host + '/api/v1/models/load', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, context_length: need }), signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!res.ok) throw await httpError('LM Studio のモデルの読み込みに失敗', res);
  // 自分が読み込んだモデルを覚えておく（実行の最後に lmstudioRelease で外す）。もともと読み込まれていたものは覚えない
  const json = await res.json().catch(() => ({}));
  state.lmstudioLoaded.push(json.instance_id || model);
  console.log('  LM Studio に ' + model + ' を文脈 ' + need + ' で読み込みました');
}

/**
 * この実行で自分が読み込んだ LM Studio のモデルだけを、アンロードする（実行の最後に呼ぶ）。
 * load で読み込んだモデルは TTL が無く、自動では外れない（2026-10-11 の実機で、チャット要求の ttl も効かなかった）。
 * 共用サーバーのメモリを占有し続けないための後片づけ。もともと読み込まれていたモデル（ほかの用途）は触らない
 */
async function lmstudioRelease() {
  const ids = state.lmstudioLoaded.splice(0);
  for (const id of ids) {
    try {
      const res = await fetch(config.lmstudio.host + '/api/v1/models/unload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: id }), signal: AbortSignal.timeout(30000)
      });
      console.log('  LM Studio の ' + id + ' をアンロードしました（' + res.status + '）');
    } catch (e) {
      console.warn('  LM Studio の ' + id + ' をアンロードできませんでした: ' + e.message);
    }
  }
}

/**
 * OpenAI 互換の chat/completions に1回問い合わせる。失敗したら投げる。
 * 先に lmstudioEnsureLoaded で文脈を確かめる。reasoning_effort: 'none' を必ず付ける（付けないと本文が空になる）。
 * 要求の途中で「Model unloaded」になったら（ほかの用途が入れ替えた）、1回だけ読み込み直して再試行する
 */
async function lmstudioChat(prompt, schema, opts = {}) {
  const started = Date.now();
  const cfg = config.lmstudio;
  const model = opts.model || (state.lmstudioModels || [])[0];
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    reasoning_effort: cfg.reasoningEffort,
    stream: false
  };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: toJsonSchema(schema) } };
  const send = () => fetch(cfg.host + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });

  await lmstudioEnsureLoaded(model);
  let res = await send();
  if (!res.ok && !opts.retried) {
    const text = await res.clone().text();
    if (/unloaded/i.test(text)) {
      console.warn('  LM Studio のモデルが途中でアンロードされました（ほかの用途が入れ替えた可能性）。読み込み直して1回だけ再試行します');
      await lmstudioEnsureLoaded(model);
      res = await send();
    }
  }
  if (!res.ok) throw await httpError('LM Studio エラー', res);
  const json = await res.json();
  const usage = json.usage || {};
  const choice = (json.choices || [])[0] || {};
  console.log(`  LM Studio ${model} ${((Date.now() - started) / 1000).toFixed(0)}秒（入力 ${usage.prompt_tokens} / 出力 ${usage.completion_tokens} トークン）`);
  if (choice.finish_reason === 'length') throw new Error('LM Studio が途中で止まりました（出力の上限か、文脈の長さ）');
  const text = (choice.message || {}).content || '';
  if (!text.trim()) throw new Error('LM Studio の応答が空でした（' + model + '）');
  state.lastModel = model;
  return schema ? parseJson(text, 'LM Studio') : text;
}

// ============================================================
// 候補（順番つき）
// ============================================================

/**
 * 使える候補を、優先順に返す。各候補は {label, local, run(parts, schema, opts)}。run は JSON を返し、失敗したら投げる。
 *   1. Ollama のモデル（config.ollama.models のうち入っているもの）
 *   2. LM Studio のモデル
 *   3. Gemini（全モデルをまとめて1候補）→ Claude
 * local の候補は、小さいモデルなので、呼び出し側が数値の照合などで確かめる（writer.js）。
 * 手元の2台は、一覧を取れなければ（起動していなければ）候補に入らない。
 */
async function candidates() {
  const list = [];
  const prompt = (parts) => parts.map((p) => p.text || '').join('\n\n');

  for (const model of await ollamaUsableModels()) {
    list.push({
      label: 'Ollama ' + model, local: true,
      run: (parts, schema, opts = {}) => ollamaChat(prompt(parts), schema, { model, numCtx: opts.numCtx || config.ollama.composeNumCtx })
    });
  }
  if (!state.noLmstudio) {
    for (const model of await lmstudioInstalled()) {
      list.push({ label: 'LM Studio ' + model, local: true, run: (parts, schema) => lmstudioChat(prompt(parts), schema, { model }) });
    }
  }
  if (!state.noExternal) {
    if (!state.geminiDown && hasEnv('GEMINI_API_KEY')) {
      list.push({
        label: 'Gemini', local: false,
        run: async (parts, schema) => {
          const out = await gemini(parts, schema);
          if (!out) throw unavailable('Gemini は全モデルが使えません');
          return out;
        }
      });
    }
    if (hasEnv('ANTHROPIC_API_KEY')) {
      list.push({
        label: 'Claude', local: false,
        run: async (parts, schema) => {
          const out = await claude(parts, schema);
          if (!out) throw unavailable('Claude を使えません');
          return out;
        }
      });
    }
  }
  return list;
}

// ============================================================
// Claude
// ============================================================

/** テストが差し替えられるように、client を作る場所を分けてある */
function createClaudeClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();   // ANTHROPIC_API_KEY を環境から読む
}

async function claude(parts, schema) {
  if (!hasEnv('ANTHROPIC_API_KEY')) return null;
  const started = Date.now();
  const client = module.exports.createClaudeClient();
  const res = await client.messages.create({
    model: config.claude.model,
    max_tokens: config.claude.maxTokens,
    output_config: {
      effort: config.claude.effort,
      format: { type: 'json_schema', schema: toJsonSchema(schema) }
    },
    messages: [{ role: 'user', content: parts.map((p) => ({ type: 'text', text: String(p.text || '') })) }]
  });
  const usage = res.usage || {};
  console.log(`  Claude ${((Date.now() - started) / 1000).toFixed(1)}秒（入力 ${usage.input_tokens} / 出力 ${usage.output_tokens} トークン）`);
  if (res.stop_reason === 'refusal') throw new Error('Claude が応答を断りました');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude が途中で止まりました（max_tokens）');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  state.lastModel = config.claude.model;
  return parseJson(text, 'Claude');
}

// ============================================================
// 入口
// ============================================================

/** 混雑で全部使えなかったことを表すエラー（論文のせいではないので、台帳に失敗として残さない） */
function unavailable(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}

/**
 * 問い合わせ（字数の書き直し・用語の確認・図の項目など）。候補を優先順に試し、最初に答えた JSON を返す。
 * opts.numCtx は Ollama の文脈の大きさ（論文の全文を渡すときは config.ollama.fullTextNumCtx）
 */
async function generateJson(parts, schema, opts = {}) {
  const tried = [];
  let lastReason = '';
  for (const c of await candidates()) {
    try {
      return await c.run(parts, schema, opts);
    } catch (e) {
      tried.push(c.label);
      lastReason = e.message;
      console.warn('  ' + c.label + ' で失敗: ' + e.message.slice(0, 160));
    }
  }
  // 最後の失敗の理由を添える（Gemini の鍵の誤り 401 などを、「使えなかった」だけで隠さない）
  throw unavailable('どの言語モデルも使えませんでした（試した順: ' + (tried.join(' → ') || 'なし') + '）' +
                    (lastReason ? ' 最後の理由: ' + lastReason.slice(0, 200) : ''));
}

module.exports = {
  generateJson, candidates, gemini, claude, ollamaChat, lmstudioChat, lmstudioRelease, ollamaInstalled, lmstudioInstalled,
  createClaudeClient, toJsonSchema, parseJson, usedModel, reset, state, unavailable
};
