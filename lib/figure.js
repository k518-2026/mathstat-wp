/**
 * 記事の先頭に付ける「研究の流れ図」（概念図）
 *
 *   記事の本文 → 言語モデルが4つの欄（対象／条件・変数／測定・手順／分析と結果）の短い語句を JSON で出す
 *   → 固定のひな形に流し込んで LuaLaTeX で描く → PNG にして images/<論文ID>.png に置く
 *
 * 守らせていること:
 *   ・語句は記事に書かれたことだけ。数値は記事にあるものだけで、プログラムで照合する（作った数値を通さない）
 *   ・図の中身は言語モデル、形は固定。形が崩れにくく、論文によらず同じ見た目になる
 *   ・失敗しても記事は捨てない。図が無い記事は、投稿のときに Pixabay の写真にする
 *
 * LaTeX が要るのはこの PC だけ。GitHub Actions は作った PNG を添付するだけ。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');
const llm = require('./llm');
const store = require('./store');
const { jaLength, normalizeSpace, cleanProse } = require('./text');

const FIG = config.figure;
const IMAGES_DIR = path.join(store.ROOT, 'images');
const BUILD_DIR = path.join(store.ROOT, 'figures', '_build');   // E:\ 配下。OS の一時フォルダ（C:）は使わない

// ============================================================
// 語句を作らせる
// ============================================================

function figureSchema() {
  const props = {};
  FIG.columns.forEach((c) => { props[c.key] = { type: 'ARRAY', items: { type: 'STRING' } }; });
  return { type: 'OBJECT', properties: props, required: FIG.columns.map((c) => c.key) };
}

/** 記事の本文（6観点）。図の材料と、数値の照合の元にする */
function articleText(article) {
  return config.sections.map((s) => article.sections[s.key] || '').join('\n');
}

function buildPrompt(article, problems) {
  return [
    '次の文章は、ある論文を紹介する記事の本文です。この記事に添える「研究の流れ図」に入れる、短い語句を作ってください。',
    '図は左から右へ、4つの欄が矢印でつながります。各欄に入れる語句を、次の指定で書いてください。',
    '- target（対象）: だれを対象にしたか。国・学年・人数・データの種類',
    '- conditions（条件・変数）: 比べた条件、または分析に使った変数（例: 統制群／介入群、予測する変数と予測される変数）',
    '- measures（測定・手順）: 何をどの順で測ったか、どんな手順か（例: 事前テスト → 授業 → 事後テスト）',
    '- results（分析と結果）: 使った分析手法と、主な結果を1つ。結果は論文の言い方の強さに合わせる',
    '',
    `各欄に 1〜${FIG.maxItems} 個の項目。1項目は ${FIG.maxChars} 字以内（「/」を除く）の短い名詞句にする（文にしない）。`,
    `図の枠は1行が約10字で、2行までしか入りません。${FIG.maxChars} 字を超えない範囲で、できるだけ短く（15字前後を目安に）書く。`,
    '1つの項目に1つの情報だけを入れる（例: 「中学生528名」「12〜15歳」）。',
    '項目が長いときは、改行してよい位置（意味の切れ目）に「/」を1つ入れる（例: 「媒介効果が/全効果の62.98%」「ベイズ的t検定/・メタ分析」）。',
    '「/」は単語の途中に入れない。「/」を入れなくても1行（約10字）に収まる短い項目には入れない。',
    '「〜に取り組む」「〜による」のような回りくどい言い方を避け、「統制群（練習問題）」のように言い切る。',
    'results（分析と結果）の欄は、1つ目に分析手法、2つ目に主な結果の数値を入れる（記事に数値があるときは必ず入れる）。',
    '【守ること】',
    '- 記事に書かれていることだけを使う。書かれていない事実・数値・用語を足さない',
    '- 数値は、記事にある数値を書式もそのまま使う。計算して新しい数値を作らない',
    '- 「実証」「証明」のような強い断定を使わない',
    '- URL・記号の飾りを入れない',
    problems && problems.length ? '\n【前回の問題点。直してください】\n' + problems.map((p) => '- ' + p).join('\n') : '',
    '',
    '【記事の本文】',
    articleText(article)
  ].filter((l) => l !== '').join('\n');
}

/** モデルの出力を整える（空白・空の項目・多すぎる項目を直す） */
function normalizeSpec(raw) {
  const spec = {};
  FIG.columns.forEach((c) => {
    spec[c.key] = ((raw && raw[c.key]) || [])
      .map((s) => normalizeSpace(cleanProse(s)).replace(/\s*\/\s*/g, '/'))
      .filter(Boolean)
      .slice(0, FIG.maxItems);
  });
  return spec;
}

/**
 * 改行してよい位置の印「/」を、LaTeX の改行（\\）にする。印を除いた字数・数値の照合は、印の無い文字で行う
 * （「/」が1つも無い項目は、枠の幅で自然に折り返される）
 */
function breakable(s) {
  return String(s).split('/').map((x) => x.trim()).filter(Boolean).map(texEscape).join('\\\\');
}

/** 印「/」を除いた表示用の文字 */
function plainItem(s) {
  return String(s).replace(/\s*\/\s*/g, '');
}

/**
 * 1行の字数（約 LINE 字）で折り返したとき、カタカナの連続（3字以上）の途中に折り返しが来るか。
 * 全角は1字、半角の英数字は約0.5字として数える
 */
const LINE = 10;
function breaksInsideKatakana(s) {
  let width = 0;
  const chars = Array.from(String(s));
  for (let i = 0; i < chars.length; i++) {
    width += /[\x20-\x7E]/.test(chars[i]) ? 0.5 : 1;
    if (width > LINE && i + 1 < chars.length) {
      // chars[i] の前で折り返される。前後がどちらもカタカナなら、語の途中
      return /[ァ-ヶー]/.test(chars[i - 1] || '') && /[ァ-ヶー]/.test(chars[i]);
    }
  }
  return false;
}

/** 問題点の一覧を返す（空なら合格） */
function validateSpec(spec, article) {
  const problems = [];
  const writer = require('./writer');
  FIG.columns.forEach((c) => {
    const items = spec[c.key] || [];
    if (!items.length) problems.push(`${c.key}（${c.title}）が空です`);
    items.forEach((t) => {
      const shown = plainItem(t);
      if (jaLength(shown) > FIG.maxChars) problems.push(`「${shown}」が ${jaLength(shown)} 字で、${FIG.maxChars} 字を超えています`);
      if (/https?:\/\/|www\./i.test(t)) problems.push(`「${shown}」に URL があります`);
      if ((t.match(/\//g) || []).length > 1) problems.push(`「${t}」の「/」は1つまでです`);
      // 改行の位置が単語の途中でないか。カタカナどうし・英数字どうし・数字どうしの間には入れない
      if (/[ァ-ヶー]\/[ァ-ヶー]|[A-Za-z0-9.]\/[A-Za-z0-9.]/.test(t)) problems.push(`「${t}」の「/」が単語の途中です`);
      // 「/」が無い項目は枠の幅（1行は約10字）で自動的に折り返される。そのとき、カタカナの語が
      // 折り返し位置（10字目の前後）をまたぐと、語の途中で切れる（例: 「ファシリテー／ター」）
      if (!t.includes('/') && breaksInsideKatakana(t)) problems.push(`「${t}」は枠の幅でカタカナの語の途中で切れます。意味の切れ目に「/」を入れてください`);
    });
  });
  // 数値は記事にあるものだけ。和（77+71=148）は許さない。「/」は除いた文字で調べる
  const text = FIG.columns.map((c) => (spec[c.key] || []).map(plainItem).join('\n')).join('\n');
  const bad = writer.checkNumbers({ sections: { what: text }, nextReads: [] }, articleText(article), { allowSums: false });
  if (bad.length) problems.push('記事にない数値があります: ' + bad.join(', '));
  return problems;
}

/** 語句を作る。1回だけ直させる。作れなければ null（理由はログに出す） */
async function makeSpec(article) {
  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    let spec;
    try {
      spec = normalizeSpec(await llm.generateJson([{ text: buildPrompt(article, problems) }], figureSchema()));
    } catch (e) {
      console.warn('  図の語句を作れませんでした: ' + e.message.slice(0, 120));
      return null;
    }
    problems = validateSpec(spec, article);
    if (!problems.length) return spec;
    console.warn('  図の語句に問題があります（' + attempt + '回目）: ' + problems.join(' / ').slice(0, 200));
  }
  return null;
}

// ============================================================
// 描く
// ============================================================

/** LaTeX の特殊文字を逃がす */
function texEscape(s) {
  return String(s == null ? '' : s).replace(/[\\{}#$%&_^~]/g, (c) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_',
    '^': '\\textasciicircum{}', '~': '\\textasciitilde{}'
  }[c]));
}

/** 図の LaTeX（standalone）を組み立てる。形は固定で、語句だけが入る */
function buildTex(spec) {
  const W = 4.0, GAP_X = 0.95, H = 1.45, GAP_Y = 0.3;
  const cols = FIG.columns.map((c) => ({ title: c.title, items: spec[c.key] }));
  const maxN = Math.max(...cols.map((c) => c.items.length));
  const step = H + GAP_Y;
  const topY = ((maxN - 1) / 2) * step + H / 2 + 0.62;
  const botY = -((maxN - 1) / 2) * step - H / 2 - 0.75;
  const totalW = cols.length * W + (cols.length - 1) * GAP_X;
  const f = (n) => n.toFixed(2);

  const nodes = [];
  cols.forEach((col, c) => {
    const x = c * (W + GAP_X) + W / 2;
    const style = c === cols.length - 1 ? 'tbox' : 'box';
    nodes.push(`\\node[title] at (${f(x)},${f(topY)}) {\\textbf{${texEscape(col.title)}}};`);
    col.items.forEach((t, i) => {
      const y = ((col.items.length - 1) / 2 - i) * step;
      nodes.push(`\\node[${style}] at (${f(x)},${f(y)}) {${breakable(t)}};`);
    });
    if (c < cols.length - 1) {
      const x1 = c * (W + GAP_X) + W + 0.1;
      const x2 = (c + 1) * (W + GAP_X) - 0.1;
      nodes.push(`\\draw[arr] (${f(x1)},0) -- (${f(x2)},0);`);
    }
  });
  nodes.push(`\\node[note] at (${f(totalW / 2)},${f(botY)}) {${texEscape(FIG.note)}};`);

  return [
    '\\documentclass[tikz,border=10pt]{standalone}',
    '\\usepackage{luatexja}',
    '\\usepackage[haranoaji]{luatexja-preset}',
    '\\ltjsetparameter{xkanjiskip={0.08\\zw plus 0.04\\zw minus 0.04\\zw}}',   // 和文と英数字の間のあき（既定は 0.25 文字分で、数字のまわりが広すぎた）
    '\\usetikzlibrary{arrows.meta}',
    '\\definecolor{ink}{HTML}{22313F}',
    '\\definecolor{gray1}{HTML}{8A97A6}',
    '\\definecolor{teal1}{HTML}{2B7A78}',
    '\\definecolor{soft}{HTML}{F2F5F7}',
    '\\begin{document}',
    '\\begin{tikzpicture}[font=\\sffamily\\gtfamily\\small, color=ink,',
    `  box/.style={rounded corners=4pt, draw=gray1, line width=0.8pt, fill=soft, align=center, inner sep=6pt, text width=${f(W - 0.55)}cm, minimum width=${f(W)}cm, minimum height=${f(H)}cm},`,
    '  tbox/.style={box, draw=teal1, fill=teal1!12},',
    '  title/.style={font=\\sffamily\\gtfamily\\footnotesize, text=teal1},',
    '  note/.style={font=\\sffamily\\gtfamily\\scriptsize, text=gray1!70!ink},',
    '  arr/.style={-{Stealth[length=2.6mm]}, line width=0.9pt, color=gray1}]',
    ...nodes,
    '\\end{tikzpicture}',
    '\\end{document}',
    ''
  ].join('\n');
}

/** 描いて PNG にする。返り値は PNG の Buffer。失敗したら投げる */
function renderPng(spec, name) {
  const dir = path.join(BUILD_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const tex = path.join(dir, 'fig.tex');
  fs.writeFileSync(tex, buildTex(spec), 'utf8');
  try {
    execFileSync(FIG.lualatex, ['-interaction=nonstopmode', '-halt-on-error', 'fig.tex'], { cwd: dir, stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    const log = fs.existsSync(path.join(dir, 'fig.log')) ? fs.readFileSync(path.join(dir, 'fig.log'), 'utf8') : '';
    const msg = (log.match(/^!.*$/m) || [e.message.split('\n')[0]])[0];
    throw new Error('LuaLaTeX が失敗: ' + msg.slice(0, 160));
  }
  execFileSync(FIG.pdftoppm, ['-r', String(FIG.dpi), '-png', '-singlefile', 'fig.pdf', 'fig'], { cwd: dir, stdio: 'pipe', timeout: 60000 });
  return fs.readFileSync(path.join(dir, 'fig.png'));
}

// ============================================================
// 入口
// ============================================================

/**
 * 記事の図を作る。成功したら語句（spec）を返し、images/<id>.png を書く（opts.write が false なら書かない）。
 * 失敗しても投げない（図は付加価値なので、記事は捨てない）
 */
async function makeFigure(id, article, opts = {}) {
  const spec = await makeSpec(article);
  if (!spec) return null;
  try {
    const png = renderPng(spec, id);
    if (opts.write !== false) {
      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      fs.writeFileSync(path.join(IMAGES_DIR, id + '.png'), png);
    }
    return spec;
  } catch (e) {
    console.warn('  図を描けませんでした: ' + e.message);
    return null;
  }
}

/** 投稿のときに添付する図。無ければ null（Pixabay の写真に戻る） */
function loadFigureImage(id) {
  const file = path.join(IMAGES_DIR, id + '.png');
  if (!fs.existsSync(file)) return null;
  return { buffer: fs.readFileSync(file), filename: 'mathstat-' + id.toLowerCase() + '.png', contentType: 'image/png', credit: FIG.credit };
}

module.exports = { breakable, plainItem, makeFigure, makeSpec, loadFigureImage, buildTex, texEscape, validateSpec, normalizeSpec, buildPrompt, renderPng, figureSchema, IMAGES_DIR };
