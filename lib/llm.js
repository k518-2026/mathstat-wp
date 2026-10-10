/**
 * 言語モデルの呼び出し（Gemini → Ollama → Claude）
 *
 * どれも「parts（{text} の配列）とスキーマを渡すと、パース済みの JSON が返る」形にそろえてある。
 * スキーマは Gemini の書き方（type が 'OBJECT' などの大文字）で書き、Ollama と Claude 向けには toJsonSchema で直す。
 *
 * 順番:
 *   1. Gemini（無料）。混雑（503）・上限（429）・名前違い（404）なら次のモデルへ。全部駄目なら少し待って巡り直す
 *   2. Mac mini の Ollama（無料・手元）。届かない・失敗したら次へ
 *   3. Claude（従量課金）。ANTHROPIC_API_KEY があるときだけ
 *
 * **一度 Gemini が全滅したら、その実行のあいだは Gemini を飛ばす**（CLAUDE.md の決まり）。
 * GAS 版で、本文を Claude で書いたあと字数の書き直しと用語確認でまた Gemini を巡り、2分を無駄にした（2026-09-24）。
 */
const { fetchRetry, httpError, hasEnv, sleep } = require('./http');
const config = require('../config');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

const state = { geminiDown: false, ollamaUp: null, lastModel: '' };
const usedModel = () => state.lastModel;

/** テストで状態を戻すため */
function reset() {
  state.geminiDown = false;
  state.ollamaUp = null;
  state.ollamaModels = null;
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
// Ollama（Mac mini）
// ============================================================

/**
 * Ollama に入っているモデルの一覧を、1回の実行で1度だけ取る。届かなければ空の一覧
 * （届かない原因はこの PC と Mac mini のネットワーク。GitHub Actions からは届かない）
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

/** 設定したモデルのうち、実際に入っているもの（全文を読ませる順）。従来の分割読み用のモデルは含めない */
async function ollamaFullTextModels() {
  const have = await ollamaInstalled();
  return (config.ollama.models || []).filter((m) => have.includes(m));
}

/** 区切って読ませる従来の方法で使うモデルが入っているか */
async function ollamaAvailable() {
  const have = await ollamaInstalled();
  state.ollamaUp = have.includes(config.ollama.model);
  return state.ollamaUp;
}

/**
 * Ollama に1回問い合わせる。失敗したら投げる。
 * think: false を必ず付ける。Qwen3.5・Gemma4 は既定で「考える」ので、出力の枠を考えるだけで使い切り、
 * 本文が空になった（2026-10-04、300トークンで content が空）
 */
async function ollamaChat(prompt, schema, opts = {}) {
  const started = Date.now();
  const model = opts.model || config.ollama.model;
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

/**
 * 短い問い合わせ（用語の確認・字数の書き直し）。全文を読めるモデル（gemma4:12b など）を優先し、
 * 入っていなければ従来のモデル（qwen2.5:14b）を使う。文脈は短いものなので既定の num_ctx で足りる
 */
async function ollama(parts, schema, opts = {}) {
  // opts.numCtx で文脈の大きさを変えられる（論文の全文を渡すときは fullTextNumCtx）。
  // 全文を渡すときは、全文を読めるモデルだけを使う（従来のモデルは文脈が短く、全文が入らない）
  const long = !!opts.numCtx && opts.numCtx > config.ollama.composeNumCtx;
  const models = (await ollamaFullTextModels()).concat(!long && (await ollamaAvailable()) ? [config.ollama.model] : []);
  const prompt = parts.map((p) => p.text || '').join('\n\n');
  for (const model of models) {
    try {
      return await ollamaChat(prompt, schema, { model, numCtx: opts.numCtx || config.ollama.composeNumCtx });
    } catch (e) {
      console.warn('  Ollama（' + model + '）で失敗: ' + e.message.slice(0, 200));
    }
  }
  return null;
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

/** 問い合わせ（字数の書き直し・用語の確認・図の項目など）。Gemini → Ollama → Claude。opts.numCtx は Ollama の文脈の大きさ */
async function generateJson(parts, schema, opts = {}) {
  let out = await gemini(parts, schema);
  if (out) return out;
  out = await ollama(parts, schema, opts);
  if (out) return out;
  out = await claude(parts, schema);
  if (out) return out;
  throw unavailable('Gemini・Ollama・Claude のどれも使えませんでした');
}

module.exports = {
  generateJson, gemini, ollama, ollamaAvailable, ollamaInstalled, ollamaFullTextModels, ollamaChat, claude, createClaudeClient,
  toJsonSchema, parseJson, usedModel, reset, state, unavailable
};
