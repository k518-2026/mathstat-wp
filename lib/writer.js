/**
 * 記事の執筆
 *
 * 守らせていること（GAS 版から引き継ぎ）:
 *   ・本文に書かれていないことを書かない
 *   ・「次に読むべき論文」はコードが OpenAlex から取った実在の候補から番号で選ばせる
 *   ・URL は書かせない（リンクはすべてコード側で付ける）
 *   ・テーマに合わない論文は relevant=false で返させ、記事にしない
 *
 * 本文の書き手は Gemini → Ollama → Claude の順。Ollama（Mac mini）は一度に約8,000トークンしか読めないので、
 * 論文を区切って「事実のメモ」を作らせ、メモから記事を書かせる（readInChunks）。
 * Ollama が書いた記事は、数値が論文に本当にあるかをプログラムで照合する（checkNumbers）。
 */
const config = require('../config');
const llm = require('./llm');
const { dropReferenceList } = require('./pdf');
const { cleanProse, jaLength, normalizeSpace, unwrapQuotes } = require('./text');

function articleSchema() {
  const sectionProps = {};
  config.sections.forEach((s) => { sectionProps[s.key] = { type: 'STRING' }; });
  return {
    type: 'OBJECT',
    properties: {
      relevant: { type: 'BOOLEAN' },
      relevanceReason: { type: 'STRING' },
      titleJa: { type: 'STRING' },
      sections: { type: 'OBJECT', properties: sectionProps, required: config.sections.map((s) => s.key) },
      nextReads: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { number: { type: 'INTEGER' }, reason: { type: 'STRING' } },
                 required: ['number', 'reason'] }
      },
      terms: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { term: { type: 'STRING' }, wikiTitle: { type: 'STRING' } },
                 required: ['term', 'wikiTitle'] }
      },
      intro: { type: 'STRING' },
      imageQuery: { type: 'STRING' }
    },
    required: ['relevant', 'relevanceReason', 'titleJa', 'sections', 'nextReads', 'terms', 'intro', 'imageQuery']
  };
}

/** source は「【論文本文】として渡したもの」の説明。Ollama のときはメモになる */
function buildPrompt(paper, readings, source) {
  const min = config.sectionMinChars;
  const max = config.sectionMaxChars;
  const list = readings.length
    ? readings.map((r, i) => `[${i + 1}] ${r.title} / ${r.venue} / ${r.year} / 被引用数 ${r.citedBy} / ${r.relation}`).join('\n')
    : '（候補なし）';

  return [
    `あなたは${config.writerRole}です。`,
    source + `日本の${config.reader}向けに、この論文を紹介する記事の材料を作ってください。` +
    '読み取れない数値は使わないでください。',
    '',
    '【最初に判定すること】',
    'relevant: この論文が次の条件に当てはまれば true、当てはまらなければ false。',
    '  条件: ' + config.relevanceRule,
    'relevanceReason: 判定の理由を日本語で1文。',
    'false の場合も、ほかの項目は空文字や空配列で構いませんが、必ず JSON で返してください。',
    '',
    `【sections（6観点）】すべて日本語の「です・ます」調。各観点 ${min}〜${max} 字（空白を除く）。` +
    // 範囲だけを示すと下限に寄るので、真ん中あたりを目安として示す
    `下限ぎりぎりにならないよう、${Math.round(min + (max - min) / 3)}〜${Math.round(min + (max - min) * 2 / 3)} 字くらいを目安にする` +
    '（nextLead は下の指定に従う）。',
    '数値（相関係数・信頼区間・人数など）は、本文にその値として書かれているものだけを使う。別の箇所の数値を組み合わせない。',
    '英語の専門用語は日本語に訳して書く（英語と日本語を混ぜない）。',
    config.sections.map((s) => `- ${s.key}: ${s.guide}`).join('\n'),
    '',
    '【nextReads】下の候補から1〜3本を選び、number に候補番号、reason にこの論文との関係と読む価値を 60〜120 字で書く。',
    '候補に無い論文を挙げてはいけません。候補は外部データベースから機械的に取ったもので、無関係な論文が混ざります。' +
    '内容が明らかにこの論文とつながるものだけを選び、関係がはっきりしない候補は選ばないでください（ふさわしい候補が無ければ空配列でよい）。' +
    '統計ソフトの解説、統計手法の一般的な教科書・解説論文、測定尺度のマニュアルのように、分析の道具として引用されているだけの文献は選ばない。',
    '候補:',
    list,
    '',
    '【terms】sections の本文に実際に出てくる専門用語を3〜8個。term は本文中の表記と一字一句同じにする。' +
    'wikiTitle はその用語の日本語版 Wikipedia の記事名として最も可能性が高いもの。',
    '',
    '【その他】',
    '- titleJa: 原題の自然な日本語訳。副題が長ければ削ってよい。原題に無い情報を足さない。全体を鉤括弧で囲まない。',
    '- intro: Bluesky でブログへ誘導する紹介文。全角 60〜90 字。読みたくなる問いや発見を1つ。URL・ハッシュタグ・絵文字は書かない。',
    '- imageQuery: 記事に添える写真を無料画像サイトで探すための英語 2〜4 語（例: "students classroom notebook"）。人名や論文名は入れない。',
    '',
    '【禁止】',
    '- 論文本文に書かれていない数値・結果・主張を書くこと。不明な点は「論文では述べられていません」と書く。',
    '- URL を書くこと。Markdown の記号（#、**、- の箇条書き）を使うこと。',
    '',
    '【論文の書誌（OpenAlex）】',
    '原題: ' + paper.title,
    '著者: ' + paper.authors.slice(0, 6).join(', '),
    '掲載誌: ' + paper.venue + ' (' + paper.year + ')',
    '被引用数: ' + paper.citedBy
  ].join('\n');
}

const FULL_TEXT_SOURCE = '【論文本文】として渡したものは学術論文の本文です（PDF から取り出した文字。図表の数値や改行が崩れていることがあります）。';
// 「英語で書かれた」は判定の条件に入っている。メモが日本語なので、原論文が英語であることをはっきり伝える
// （伝えないと「英語で書かれていない」とテーマ外にされた。2026-10-04 の試行、数直線推定の論文）
const NOTES_SOURCE = '【論文のメモ】として渡したものは、英語で書かれた学術論文の本文を部分ごとに読み、' +
  '事実を日本語で書き出したメモです（原論文は英語です。メモが日本語なのは、こちらで訳したためです）。メモに無いことは書かないでください。';

/** 本文を段落の切れ目で、だいたい size 字ずつに分ける */
function splitChunks(text, size) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Ollama 用。論文を区切って読ませ、部分ごとに事実のメモを作らせる。
 * メモは本文の数値を表記のまま残させる（あとで checkNumbers が本文と照合する）
 */
async function readInChunks(mainText) {
  const text = mainText.slice(0, config.ollama.maxChars);
  const chunks = splitChunks(text, config.ollama.chunkChars);
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`  Ollama で本文を読んでいます（${i + 1}/${chunks.length}）`);
    const note = await llm.ollamaChat([
      `次は学術論文の本文の一部です（全${chunks.length}部分のうち ${i + 1} 番目）。`,
      'この部分に書かれている事実だけを、日本語の短い箇条書きのメモにしてください（400字以内）。',
      '対象（国・学年・人数）、目的、使った尺度や課題、統計手法、変数、主な結果、限界のうち、この部分にあるものだけ。',
      '数値は本文の表記のまま書き写す（丸めない・計算しない）。書かれていないことは書かない。参考文献の一覧は無視する。',
      '',
      chunks[i]
    ].join('\n'), null);
    notes.push(`（部分${i + 1}）\n` + String(note).trim());
  }
  return notes.join('\n\n');
}

/**
 * 論文1本から記事の材料を作る。
 * 返り値は normalize 済みの記事。どのモデルも使えなければ transient なエラーを投げる（次の実行で取り直す）
 */
async function writeArticle(paper, pdfText, readings) {
  const main = dropReferenceList(pdfText);
  const clipped = main.slice(0, config.pdfTextMaxChars);
  const fullParts = [
    { text: '【論文本文】' + (main.length < pdfText.length ? '（参考文献リストは省略）' : '') +
            (main.length > clipped.length ? '（長いので後半を省略）' : '') + '\n' + clipped },
    { text: buildPrompt(paper, readings, FULL_TEXT_SOURCE) }
  ];
  const schema = articleSchema();

  // 1. Gemini（全文）
  let raw = await llm.gemini(fullParts, schema);
  let byLocal = false;

  // 2. Ollama（区切って読ませたメモから）
  if (!raw && await llm.ollamaAvailable()) {
    try {
      const notes = await readInChunks(main);
      raw = await llm.ollamaChat('【論文のメモ】\n' + notes + '\n\n' + buildPrompt(paper, readings, NOTES_SOURCE), schema,
        { numCtx: config.ollama.composeNumCtx });
      byLocal = true;
    } catch (e) {
      console.warn('  Ollama で記事を書けませんでした: ' + e.message.slice(0, 200));
      raw = null;
    }
  }
  let article = raw ? normalize(raw, readings) : null;
  if (article) article.model = byLocal ? config.ollama.model : llm.usedModel();

  // Ollama の記事は、数値が論文に無ければ使わない（小さいモデルは数値を作ってしまうことがある）
  if (article && byLocal && article.relevant) {
    const bad = checkNumbers(article, pdfText);
    if (bad.length) {
      console.warn('  Ollama の記事に、論文に無い数値があります: ' + bad.join(', ') + ' → Claude で書き直します');
      article = null;
    }
  }

  // 3. Claude（全文）
  if (!article) {
    const fromClaude = await llm.claude(fullParts, schema);
    if (!fromClaude) throw llm.unavailable('記事を書けるモデルがありませんでした（Gemini は混雑、Ollama は失敗か数値の不一致、Claude は鍵なし）');
    article = normalize(fromClaude, readings);
    article.model = config.claude.model;
  }

  if (article.relevant) {
    const bad = checkNumbers(article, pdfText);
    if (bad.length) article.warnings.push('論文の本文に見つからない数値: ' + bad.join(', '));
    await fixSectionLengths(article);
  }
  return article;
}

/** モデルの出力を整える。番号の範囲外や重複、本文に無い用語を落とす */
function normalize(raw, readings) {
  const sections = {};
  config.sections.forEach((s) => { sections[s.key] = cleanProse(((raw && raw.sections) || {})[s.key]); });

  const used = {};
  const nextReads = [];
  ((raw && raw.nextReads) || []).forEach((n) => {
    const i = Number(n.number) - 1;
    if (!(i >= 0 && i < readings.length) || used[i] || nextReads.length >= 3) return;
    used[i] = true;
    nextReads.push({ paper: citationFields(readings[i]), reason: cleanProse(n.reason) });
  });

  const body = config.sections.map((s) => sections[s.key]).join('\n');
  const terms = ((raw && raw.terms) || [])
    .map((t) => ({ term: normalizeSpace(t.term), wikiTitle: normalizeSpace(t.wikiTitle) }))
    .filter((t) => t.term && body.includes(t.term))
    .slice(0, config.wikiLinkMax);

  return {
    relevant: !!(raw && raw.relevant),
    relevanceReason: cleanProse(raw && raw.relevanceReason),
    titleJa: unwrapQuotes(normalizeSpace(cleanProse(raw && raw.titleJa))),
    sections,
    nextReads,
    terms,
    links: [],
    intro: normalizeSpace(cleanProse(raw && raw.intro)),
    imageQuery: normalizeSpace(String((raw && raw.imageQuery) || '').replace(/[^\x20-\x7E]/g, ' ')).slice(0, 100),
    warnings: []
  };
}

/** 書誌に要る項目だけ残す（参考文献IDの配列などは捨てる） */
function citationFields(p) {
  return {
    id: p.id, doi: p.doi, title: p.title, authors: (p.authors || []).slice(0, 4),
    authorCount: (p.authors || []).length, venue: p.venue, volume: p.volume, issue: p.issue,
    pages: p.pages, year: p.year, citedBy: p.citedBy, url: p.url
  };
}

/**
 * 記事に出てくる数値が、論文の本文にあるかを確かめる。見つからない数値の一覧を返す。
 * 1桁の整数（「6つの観点」「4年生」など）は数えない。小数は .21 と 0.21 のどちらでも探す。
 */
function checkNumbers(article, paperText) {
  const hay = String(paperText).replace(/(\d),(\d{3})/g, '$1$2').replace(/[−–]/g, '-');
  const prose = config.sections.map((s) => article.sections[s.key]).join('\n') +
                '\n' + (article.nextReads || []).map((n) => n.reason).join('\n');
  const found = prose.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || [];
  const bad = [];
  found.forEach((n) => {
    if (/^\d$/.test(n) || bad.includes(n)) return;
    const variants = [n];
    if (/^0\.\d+$/.test(n)) variants.push(n.slice(1));            // 0.21 → .21
    if (/^\d+\.\d*0$/.test(n)) variants.push(n.replace(/0+$/, '').replace(/\.$/, ''));   // 0.30 → 0.3
    const ok = variants.some((v) => new RegExp('(^|[^0-9.])' + v.replace('.', '\\.') + '(?![0-9])').test(hay));
    if (!ok) bad.push(n);
  });
  return bad;
}

/**
 * 観点の字数。(6) は導入文だけでなく、推薦理由も合わせて数える。
 * 導入文だけで150字を求めたら水増しで280字に書き直された（2026-09-15、GAS 版 MathStat）
 */
function sectionLength(article, key) {
  let n = jaLength(article.sections[key]);
  if (key === 'nextLead') (article.nextReads || []).forEach((r) => { n += jaLength(r.reason); });
  return n;
}

/** 字数が範囲外の観点。少しの超過・不足は許す（書き直しの往復を減らすため） */
function sectionsOutOfRange(article) {
  const lo = Math.floor(config.sectionMinChars * 0.9);
  const hi = Math.ceil(config.sectionMaxChars * 1.1);
  return config.sections.filter((s) => {
    const n = sectionLength(article, s.key);
    return n < lo || n > hi;
  });
}

/** 字数が外れた観点だけ、本文なしで書き直させる。(6) の導入文は字数だけを理由に書き直さない */
async function fixSectionLengths(article) {
  const bad = sectionsOutOfRange(article).filter((s) => !s.lead);
  if (bad.length) {
    const schema = {
      type: 'OBJECT',
      properties: Object.fromEntries(bad.map((s) => [s.key, { type: 'STRING' }])),
      required: bad.map((s) => s.key)
    };
    const prompt = '次の各文章を、意味と事実を変えずに、それぞれ空白を除いて ' +
      config.sectionMinChars + '〜' + config.sectionMaxChars + ' 字の日本語（です・ます調）に書き直してください。\n' +
      '新しい事実や数値を足さないこと。短すぎる場合は、書かれている内容の説明を丁寧にして増やすこと。' +
      '「〜していただくことができます」「非常に」のような中身のない言い回しで字数を埋めないこと。\n\n' +
      bad.map((s) => `【${s.key}】（現在 ${jaLength(article.sections[s.key])} 字）\n${article.sections[s.key]}`).join('\n\n');
    try {
      const fixed = await llm.generateJson([{ text: prompt }], schema);
      bad.forEach((s) => {
        const t = cleanProse(fixed[s.key]);
        if (t) article.sections[s.key] = t;
      });
    } catch (e) {
      // 本文はもうできているので、字数が少し外れたまま完成させる
      article.warnings.push('字数の調整に失敗: ' + e.message.slice(0, 80));
    }
  }
  sectionsOutOfRange(article).forEach((s) => {
    article.warnings.push(s.heading + ' が ' + sectionLength(article, s.key) + ' 字');
  });
}

module.exports = {
  writeArticle, buildPrompt, articleSchema, normalize, citationFields, checkNumbers, splitChunks,
  sectionLength, sectionsOutOfRange, fixSectionLengths, readInChunks
};
