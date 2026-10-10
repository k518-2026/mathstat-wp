/**
 * 記事の先頭に付ける「研究の流れ図」（その論文の研究方法の図）
 *
 *   元の論文の本文 → 言語モデルが4つの欄（対象／条件・変数／測定・手順／分析と結果）の項目を出す
 *   （各項目に、論文の本文からそのまま写した「根拠の文」を付けさせる）
 *   → 根拠の文が本文にあるか、数値が根拠の文にあるかをプログラムで照合し、通った項目だけを残す
 *   → 固定のひな形に流し込んで LuaLaTeX で描く → PNG にして images/<論文ID>.png に置く
 *
 * 守らせていること（2026-10-11 ユーザー指示「参考引用論文の研究方法に合わせ、勝手な想像では作らず、事実を確認しながら」）:
 *   ・材料は記事（要約）ではなく、元の論文の本文。要約の誤りを図に持ち込まない
 *   ・根拠の文が本文に無い項目は図に入れない。数値は、その項目の根拠の文にあるものだけ
 *   ・研究の種類（実験・相関・縦断・尺度の開発・メタ分析など）に合わせ、論文が書いている方法を写す
 *   ・図の形は固定。語句だけが入る。図には出典の論文と「実際のデータの図ではない」ことを書く
 *   ・失敗しても記事は捨てない。図が無い記事は、図ができるまで投稿しない（写真は使わない）
 *
 * LaTeX が要るのはこの PC だけ。GitHub Actions は作った PNG を添付するだけ。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');
const llm = require('./llm');
const store = require('./store');
const pdf = require('./pdf');
const { jaLength, normalizeSpace, cleanProse } = require('./text');

const FIG = config.figure;
const IMAGES_DIR = path.join(store.ROOT, 'images');
const BUILD_DIR = path.join(store.ROOT, 'figures', '_build');   // E:\ 配下。OS の一時フォルダ（C:）は使わない
const CACHE_DIR = path.join(store.ROOT, 'figures', '_cache');   // 論文の本文の文字（全文は GitHub に置かない。.gitignore 済み）

// ============================================================
// 論文の本文
// ============================================================

/**
 * 論文の本文の文字を返す。無ければ取れなければ null。
 * 手元の figures/_cache に置く（図の作り直しのたびに PDF を取り直さないため。全文なので GitHub には置かない）
 */
async function getPaperText(entry) {
  const id = entry.paper.id;
  const cache = path.join(CACHE_DIR, id + '.txt');
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
  if (!entry.paper.pdfUrl) { console.warn('  ' + id + ' の PDF の URL が記録されていません'); return null; }
  const file = await pdf.fetchPdf({ title: entry.paper.title, pdfUrls: [entry.paper.pdfUrl] });
  if (!file) return null;
  const text = pdf.extractText(file);
  if (text.length < config.pdfTextMinChars) { console.warn('  ' + id + ' の本文を文字にできませんでした（' + text.length + ' 字）'); return null; }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cache, text, 'utf8');
  return text;
}

// ============================================================
// 照合（根拠の文が、論文の本文にあるか）
// ============================================================

/**
 * 文字だけにする（英数字・日本語の文字以外を全部取る）。PDF の文字起こしは、改行・ハイフンでの語の分割・
 * 空白・引用符が原文と違うことがあるので、そこを無視して「文字の並び」が同じかを比べる
 */
function squash(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 照合の材料。本文は参考文献を除いた、言語モデルに渡したものと同じ範囲 */
function makeContext(paperText) {
  const main = pdf.dropReferenceList(paperText).slice(0, config.pdfTextMaxChars);
  return { main, hay: squash(main) };
}

// ============================================================
// 項目を作らせる
// ============================================================

function figureSchema() {
  const item = { type: 'OBJECT', properties: { text: { type: 'STRING' }, evidence: { type: 'STRING' } }, required: ['text', 'evidence'] };
  const props = {};
  FIG.columns.forEach((c) => { props[c.key] = { type: 'ARRAY', items: item }; });
  return { type: 'OBJECT', properties: props, required: FIG.columns.map((c) => c.key) };
}

function buildPrompt(entry, problems) {
  const p = entry.paper;
  return [
    '上の【論文本文】は、英語の学術論文の本文です。この論文自身が行った**研究の方法**を、4つの欄の流れ図にまとめます。',
    '図は左から右へ、4つの欄が矢印でつながります。各欄の項目を、次の指定で書いてください。',
    '- target（対象）: 研究の対象。参加者（国・学年・人数）、使ったデータ、メタ分析なら集めた研究の数や検索の範囲',
    '- conditions（条件・変数）: 比べた群・条件、または分析に使った変数や尺度の構成概念（実験なら統制群と介入群、相関研究なら予測する変数と予測される変数、など）',
    '- measures（測定・手順）: 何をどの順で測ったか、どんな手順で行ったか（事前テスト → 指導 → 事後テスト、調査の段階、研究の選別の手順など）。',
    '  統計分析（因子分析・回帰分析・検定など）は、手順ではなく results（分析と結果）の欄に入れる',
    '- results（分析と結果）: 使った分析手法と、論文が報告している主な結果。研究や条件によって結果が違う論文では、そのことが分かるように入れる',
    '  （例: 「研究1は結論が出ず、研究2・3は帰無仮説を支持」のように。結果が弱い・はっきりしない研究を省かない）',
    '  分析手法は「ベイズ的 t 検定」「階層的重回帰分析」のように手法の名前で書き、結果は平易に書く',
    '  **論文が数値で結果を報告しているときは、結果の項目に、その数値を入れる**（例: 「実験群 36.33 点・統制群 18.30 点」。数値は根拠の文にあるものだけ）。数値を省いて「高い」「差がある」とだけ書かない',
    '',
    '【研究の種類に合わせる】',
    '実験・準実験、相関・回帰、縦断研究、尺度の開発、メタ分析、質的研究など、研究の種類は論文によって違います。',
    '種類を決めつけず、この論文が書いている方法をそのまま写してください。当てはまらない欄でも、論文が書いていることだけを入れます。',
    '',
    '【項目の書き方】',
    '各項目は text と evidence の2つです。',
    `- text: 図に載せる日本語の短い名詞句（${FIG.maxChars} 字以内、「/」を除く。文にしない。15字前後が目安）`,
    '- evidence: その項目を裏づける、**論文の本文からそのまま写した英語の文（または文の一部）**。15〜150 字。1つの続いた箇所から、一字一句変えずに写す。言い換え・要約・翻訳をしない',
    '',
    `各欄に 1〜${FIG.maxItems} 個。1項目に1つの情報だけを入れる（例: 「中学生528名」「12〜15歳」）。`,
    `図の枠は1行が約10字で、2行までです。長い項目は、改行してよい位置（意味の切れ目）に「/」を1つ入れる（例: 「統制群/（練習問題）」）。`,
    '「/」は単語の途中に入れない。1行に収まる短い項目には入れない。',
    '',
    '【守ること】',
    '- **論文の本文に書かれていることだけ**を使う。あなたの知識や推測を足さない。本文に書かれていない欄の項目は作らない',
    '- text の数値は、その項目の evidence にある数値を、そのまま使う。計算して新しい数値を作らない（人数の合計なども作らない）',
    '- 論文の言い方の強さに合わせる（「証明」「実証」のような強い断定をしない。ベイズ因子や有意性は論文の表現のとおりに）',
    '- 論文が「〜と報告している」ことと、論文が行った方法を区別する。先行研究が行った方法は入れない（この論文が行った方法だけ）',
    '- URL・記号の飾りを入れない',
    problems && problems.length ? '\n【前回の問題点。直してください】\n' + problems.map((x) => '- ' + x).join('\n') : '',
    '',
    '【論文の書誌（参考。evidence には使わない）】',
    '原題: ' + p.title,
    '掲載誌: ' + (p.venue || '') + ' (' + (p.year || '') + ')'
  ].filter((l) => l !== '').join('\n');
}

/** モデルの出力を整える（空白・空の項目・多すぎる項目を直す）。返り値は {欄: [{text, evidence}]} */
function normalizeSpec(raw) {
  const spec = {};
  FIG.columns.forEach((c) => {
    spec[c.key] = ((raw && raw[c.key]) || [])
      .map((it) => ({
        text: normalizeSpace(cleanProse(it && it.text)).replace(/\s*\/\s*/g, '/'),
        evidence: normalizeSpace(it && it.evidence)   // 根拠の文は本文のとおりに残す（cleanProse は URL を消すので使わない）
      }))
      .filter((it) => it.text)
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

/** 1項目の問題点の一覧（空なら合格）。事実の照合（論文の本文と根拠の文）と、図に収まる書き方を調べる */
function itemProblems(item, ctx) {
  const problems = [];
  const writer = require('./writer');
  const t = item.text || '';
  const shown = plainItem(t);
  const label = '「' + shown + '」';

  // 書き方（図に収まるか）
  if (jaLength(shown) > FIG.maxChars) problems.push(`${label}が ${jaLength(shown)} 字で、${FIG.maxChars} 字を超えています`);
  if (/https?:\/\/|www\./i.test(t)) problems.push(`${label}に URL があります`);
  if ((t.match(/\//g) || []).length > 1) problems.push(`${label}の「/」は1つまでです`);
  // 改行の位置が単語の途中でないか。カタカナどうし・英数字どうし・数字どうしの間には入れない
  if (/[ァ-ヶー]\/[ァ-ヶー]|[A-Za-z0-9.]\/[A-Za-z0-9.]/.test(t)) problems.push(`${label}の「/」が単語の途中です`);
  // 「/」が無い項目は枠の幅（1行は約10字）で自動的に折り返される。そのとき、カタカナの語が
  // 折り返し位置（10字目の前後）をまたぐと、語の途中で切れる（例: 「ファシリテー／ター」）
  if (!t.includes('/') && breaksInsideKatakana(t)) problems.push(`${label}は枠の幅でカタカナの語の途中で切れます。意味の切れ目に「/」を入れてください`);

  // 事実（論文の本文との照合）
  const ev = item.evidence || '';
  const key = squash(ev);
  if (key.length < 12) {
    problems.push(`${label}の根拠の文（evidence）が短すぎるか空です。論文の本文から15字以上をそのまま写してください`);
  } else if (!ctx.hay.includes(key)) {
    problems.push(`${label}の根拠の文が論文の本文にありません（言い換えず、本文のとおりに写してください）: ${ev.slice(0, 60)}`);
  }
  // 数値は、その項目の根拠の文にあるものだけ。和（77+71=148）は許さない
  const bad = writer.checkNumbers({ sections: { what: shown }, nextReads: [] }, ev, { allowSums: false });
  if (bad.length) problems.push(`${label}の数値（${bad.join(', ')}）が、根拠の文にありません`);
  return problems;
}

/** 問題点の一覧を返す（空なら合格） */
function validateSpec(spec, ctx) {
  const problems = [];
  FIG.columns.forEach((c) => {
    const items = spec[c.key] || [];
    if (!items.length) problems.push(`${c.key}（${c.title}）が空です`);
    items.forEach((it) => problems.push(...itemProblems(it, ctx)));
  });
  return problems;
}

/** 問題のある項目を取り除く。返り値は {spec, dropped: [取り除いた項目の text]} */
function pruneSpec(spec, ctx) {
  const out = {};
  const dropped = [];
  FIG.columns.forEach((c) => {
    out[c.key] = (spec[c.key] || []).filter((it) => {
      if (itemProblems(it, ctx).length === 0) return true;
      dropped.push(plainItem(it.text));
      return false;
    });
  });
  return { spec: out, dropped };
}

/**
 * 項目を作る。1回だけ直させる。それでも照合に通らない項目は取り除き、どの欄も1つ以上残れば採用する。
 * 欄が空になれば null（図は作らない。理由はログに出す）
 */
async function makeSpec(entry, paperText) {
  const ctx = makeContext(paperText);
  let problems = [];
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      last = normalizeSpec(await llm.generateJson(
        [{ text: '【論文本文】\n' + ctx.main }, { text: buildPrompt(entry, problems) }],
        figureSchema(), { numCtx: config.ollama.fullTextNumCtx }));
    } catch (e) {
      console.warn('  図の項目を作れませんでした: ' + e.message.slice(0, 120));
      return null;
    }
    problems = validateSpec(last, ctx);
    if (!problems.length) return last;
    console.warn('  図の項目に問題があります（' + attempt + '回目）: ' + problems.join(' / ').slice(0, 260));
  }
  const { spec, dropped } = pruneSpec(last, ctx);
  if (dropped.length) console.warn('  照合に通らない項目を図から外しました: ' + dropped.join(' / '));
  const empty = FIG.columns.filter((c) => !spec[c.key].length).map((c) => c.title);
  if (empty.length) { console.warn('  照合に通る項目が無い欄があります（' + empty.join('・') + '）。図は作りません'); return null; }
  return spec;
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

/** 図の下に書く出典。「Passolunghi ら（2018）」のように、第一著者の姓と年 */
function sourceNote(paper) {
  const authors = (paper && paper.authors) || [];
  const first = String(authors[0] || '').trim().split(/\s+/).pop();
  const many = ((paper && paper.authorCount) || authors.length) > 1;
  const who = first ? first + (many ? ' ら' : '') + (paper.year ? '（' + paper.year + '）' : '') : (paper && paper.year) || '';
  return (who ? '出典：' + who + '。' : '') + FIG.note;
}

/** 図の LaTeX（standalone）を組み立てる。形は固定で、語句だけが入る。meta は出典の論文（書誌） */
function buildTex(spec, meta) {
  const W = 4.0, GAP_X = 0.95, H = 1.45, GAP_Y = 0.3;
  const cols = FIG.columns.map((c) => ({ title: c.title, items: spec[c.key].map((it) => (typeof it === 'string' ? it : it.text)) }));
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
  nodes.push(`\\node[note] at (${f(totalW / 2)},${f(botY)}) {${texEscape(sourceNote(meta))}};`);

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
function renderPng(spec, name, meta) {
  const dir = path.join(BUILD_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const tex = path.join(dir, 'fig.tex');
  fs.writeFileSync(tex, buildTex(spec, meta), 'utf8');
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
 * 論文の図を作る。entry は articles/<id>.json の中身（{paper, article}）。
 * 成功したら項目（spec）を返し、images/<id>.png を書く（opts.write が false なら書かない）。
 * opts.paperText に論文の本文を渡せる（記事づくりの途中で、すでに取ってあるとき）。
 * 失敗しても投げない（図は付加価値なので、記事は捨てない）
 */
async function makeFigure(id, entry, opts = {}) {
  const paperText = opts.paperText || await getPaperText(entry);
  if (!paperText) { console.warn('  論文の本文を取れないため、図は作れません'); return null; }
  const spec = await makeSpec(entry, paperText);
  if (!spec) return null;
  try {
    const png = renderPng(spec, id, entry.paper);
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

/** 記事のファイルに、根拠の文つきの図の項目が記録されているか（記事から作った古い図は、根拠が無い） */
function isGrounded(entry) {
  const f = entry && entry.figure;
  if (!f) return false;
  const items = FIG.columns.flatMap((c) => f[c.key] || []);
  return items.length > 0 && items.every((it) => it && typeof it === 'object' && String(it.evidence || '').length >= 12);
}

/** 図のファイルがあるか */
function hasFigure(id) {
  return fs.existsSync(path.join(IMAGES_DIR, id + '.png'));
}

/**
 * 投稿してよい図か。図のファイルがあり、かつ記事のファイルに、論文の本文からの根拠つきの項目が記録されている。
 * 記事から作った古い図（根拠の記録が無い）は、作り直すまで投稿しない（2026-10-11 ユーザー判断）
 */
function isPostable(id) {
  return hasFigure(id) && isGrounded(store.loadArticle(id));
}

/**
 * 図の「分析と結果」の欄に数値が入っているか。論文が数値で結果を報告しているのに、図に数値が無い図は、
 * 結果が伝わらない（2026-10-11 の確認で、数値の無い図が2枚あった）。数値の入った図を先に投稿するために使う
 */
function resultsHaveNumbers(id) {
  const entry = store.loadArticle(id);
  const results = (entry && entry.figure && entry.figure.results) || [];
  return results.some((it) => /\d/.test(typeof it === 'string' ? it : it.text));
}

/**
 * 投稿のときに添付する図。無ければ null。
 * 図の無い記事は投稿しない（Pixabay の写真は 2026-10-11 のユーザー判断でやめた。具体的な研究手法の図のほうが価値がある）
 */
function loadFigureImage(id) {
  const file = path.join(IMAGES_DIR, id + '.png');
  if (!fs.existsSync(file)) return null;
  return { buffer: fs.readFileSync(file), filename: 'mathstat-' + id.toLowerCase() + '.png', contentType: 'image/png', credit: FIG.credit };
}

/**
 * 記事の図が無ければ作り、項目（根拠の文つき）を記事のファイル（articles/<id>.json）に残す。
 * 返り値は 'have' / 'made' / 'failed'。失敗しても投げない。opts.force なら、あっても作り直す
 */
async function ensureFigure(id, opts = {}) {
  const entry = store.loadArticle(id);
  // 論文の本文から根拠の文つきで作った図か。記事から作った古い図（根拠の記録が無い）は、作り直す
  // （2026-10-11 ユーザー指示: 参考引用論文の研究方法に合わせ、勝手な想像では作らず、事実を確認しながら作る）
  if (hasFigure(id) && !opts.force && isGrounded(entry)) return 'have';
  if (!entry) { console.warn('  ' + id + ' の記事のファイルがありません'); return 'failed'; }
  console.log('  研究の流れ図を作ります: ' + id + ' ' + (entry.article.titleJa || ''));
  const spec = await makeFigure(id, entry, { write: opts.write !== false, paperText: opts.paperText });
  if (!spec) return 'failed';
  if (opts.write !== false) { entry.figure = spec; store.saveArticle(id, entry); }
  return 'made';
}

module.exports = {
  breakable, plainItem, sourceNote, squash, makeContext, itemProblems, pruneSpec, makeFigure, makeSpec, hasFigure, isGrounded, isPostable, resultsHaveNumbers,
  loadFigureImage, ensureFigure, getPaperText, buildTex, texEscape, validateSpec, normalizeSpec, buildPrompt, renderPng,
  figureSchema, IMAGES_DIR, CACHE_DIR
};
