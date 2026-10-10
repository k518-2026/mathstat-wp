/**
 * 記事の執筆
 *
 * 守らせていること（GAS 版から引き継ぎ）:
 *   ・本文に書かれていないことを書かない
 *   ・「次に読むべき論文」はコードが OpenAlex から取った実在の候補から番号で選ばせる
 *   ・URL は書かせない（リンクはすべてコード側で付ける）
 *   ・テーマに合わない論文は relevant=false で返させ、記事にしない
 *
 * 本文の書き手は、llm.candidates() の優先順（手元の Ollama → LM Studio → Gemini → Claude）。論文の全文を1回で読ませる。
 * 手元のモデルが書いた記事は、数値が論文に本当にあるかをプログラムで照合し（checkNumbers）、
 * テーマの判定は問いを分けて答えさせる（classifyLocal）。通らなければ次の候補に回す。
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
      intro: { type: 'STRING' }
    },
    required: ['relevant', 'relevanceReason', 'titleJa', 'sections', 'nextReads', 'terms', 'intro']
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
    '「実証された」「証明された」「非常に新規性が高い」のような断定・強調は使わない。論文が「証拠がある」「示唆する」と書いている強さに合わせ、' +
    'ベイズ因子・p値・信頼区間は、その強さの区分（論文が「実質的な証拠」と呼ぶなど）を添える。' +
    '複数の研究を並べて紹介するときは、結果が弱い・はっきりしない研究も省かずに書く。',
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

/**
 * 手元のモデル用。テーマに合うかを、問いを分けて「はい／いいえ」で答えさせ、結論はコードで出す。
 * 条件をまとめて判定させると、小さいモデルは「脳画像の研究ではありません」を理由にテーマ外とするなど、
 * 理由と結論が食い違った（2026-10-04 の試行、数直線推定の論文で2回）。
 * 論文の冒頭（要旨・方法）を渡す。全文を渡すと判定だけに余計に時間がかかるため。
 * candidate は llm.candidates() の1つ（同じモデルに聞く）
 */
async function classifyLocal(paper, text, candidate) {
  const schema = {
    type: 'OBJECT',
    properties: {
      aboutMathLearning: { type: 'BOOLEAN' },
      quantitativeStatistics: { type: 'BOOLEAN' },
      brainImagingIsMainTopic: { type: 'BOOLEAN' },
      explainsStatisticalMethodOnly: { type: 'BOOLEAN' },
      qualitativeOnly: { type: 'BOOLEAN' }
    },
    required: ['aboutMathLearning', 'quantitativeStatistics', 'brainImagingIsMainTopic', 'explainsStatisticalMethodOnly', 'qualitativeOnly']
  };
  const a = await candidate.run([{ text: [
    '次は、ある学術論文（英語）の本文の冒頭です。本文に基づいて、各問いに true か false で答えてください。',
    '- aboutMathLearning: 算数・数学の学習・指導・能力（幼児期から大学初年次）を対象にしているか',
    '- quantitativeStatistics: 人数のあるデータを、回帰・分散分析・相関・構造方程式モデリング・マルチレベル分析・メタ分析などで統計的に分析しているか',
    '- brainImagingIsMainTopic: fMRI・脳波などの脳画像・脳活動の計測が研究の中心か（使っていなければ false）',
    '- explainsStatisticalMethodOnly: 統計手法そのものの解説だけで、学習者のデータを分析していないか',
    '- qualitativeOnly: インタビューや観察などの質的な分析だけか',
    '',
    '原題: ' + paper.title,
    '',
    '【本文の冒頭】',
    text.slice(0, 9000)
  ].join('\n') }], schema, { numCtx: config.ollama.composeNumCtx });

  const relevant = !!a.aboutMathLearning && !!a.quantitativeStatistics &&
                   !a.brainImagingIsMainTopic && !a.explainsStatisticalMethodOnly && !a.qualitativeOnly;
  const why = [];
  if (!a.aboutMathLearning) why.push('算数・数学の学習が対象ではない');
  if (!a.quantitativeStatistics) why.push('量的な統計分析ではない');
  if (a.brainImagingIsMainTopic) why.push('脳画像が中心');
  if (a.explainsStatisticalMethodOnly) why.push('統計手法の解説');
  if (a.qualitativeOnly) why.push('質的研究のみ');
  return { relevant, reason: relevant ? '算数・数学の学習を対象にした量的研究（' + candidate.label + ' の判定）' : why.join('・') + '（' + candidate.label + ' の判定）' };
}

/**
 * 論文1本から記事の材料を作る。
 * 返り値は normalize 済みの記事。どの候補でも書けなければ transient なエラーを投げる（次の実行で取り直す）
 *
 * 候補は llm.candidates() の優先順（手元の Ollama → LM Studio → Gemini → Claude）に試す。
 * 手元のモデル（local）は小さいので、確かめてから採用する:
 *   ・テーマの判定は、問いを分けた答えで決める（classifyLocal）
 *   ・記事の数値が論文の本文に無ければ、その候補の記事は使わず、次の候補へ回す
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

  let article = null;
  const tried = [];
  for (const c of await llm.candidates()) {
    try {
      console.log('  ' + c.label + ' に全文を読ませます');
      let raw = await c.run(fullParts, schema, { numCtx: config.ollama.fullTextNumCtx });
      if (c.local) {
        const verdict = await classifyLocal(paper, clipped, c);
        raw.relevant = verdict.relevant;
        raw.relevanceReason = verdict.reason;
      }
      const candidate = normalize(raw, readings);
      candidate.model = llm.usedModel();
      // 手元のモデルの記事は、数値が論文に無ければ使わない（小さいモデルは数値を作ってしまうことがある）
      if (c.local && candidate.relevant) {
        const bad = checkNumbers(candidate, pdfText);
        if (bad.length) {
          console.warn('  ' + c.label + ' の記事に、論文に無い数値があります: ' + bad.join(', ') + ' → 次の候補で書き直します');
          tried.push(c.label + '（数値の不一致）');
          continue;
        }
      }
      article = candidate;
      break;
    } catch (e) {
      tried.push(c.label);
      console.warn('  ' + c.label + ' で記事を書けませんでした: ' + e.message.slice(0, 200));
    }
  }
  if (!article) throw llm.unavailable('記事を書ける言語モデルがありませんでした（試した順: ' + (tried.join(' → ') || '候補なし') + '）');

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
 * 本文に出てくる整数（人数などの 10〜99999）のうち、2つの和になる値の集合。
 * 論文が「2年生77名、4年生71名」と書いたとき、記事が「合計148名」と書くのは誤りではない。
 * 本文の整数は多くても数百個なので、全組み合わせでも軽い。ただし小さい数どうしの和は偶然一致しやすいので、
 * 和が 100 以上のものだけを許す
 */
function pairSums(text) {
  const nums = Array.from(new Set((String(text).match(/(?<![\d.])\d{2,5}(?![\d.])/g) || []).map(Number))).slice(0, 600);
  const sums = new Set();
  for (let i = 0; i < nums.length; i++) {
    for (let j = i; j < nums.length; j++) {
      if (nums[i] + nums[j] >= 100) sums.add(nums[i] + nums[j]);
    }
  }
  return sums;
}

/** 3桁区切りのカンマを外す。1,159,295 のように区切りが続くものは、なくなるまで繰り返す（g フラグだけでは1つおきになる） */
function stripThousands(text) {
  let s = String(text);
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2'); }
  return s;
}

/**
 * 日本語の「115万9295」「3万」「1億2000万」を算用数字に直す（論文は 1,159,295 と書く）。
 * 直さないと「115」と「9295」を別々に探して、正しい数値を「本文に無い」と誤って警告した（2026-10-04）
 */
function expandManUnits(text) {
  // 「億」「万」と、そのあとに続く端数までを1つの数にする。例: 1億2000万 → 120000000、115万9295 → 1159295
  return String(text).replace(/(?:(\d+)億)?(?:(\d+)万)?(\d+)?/g, (m, oku, man, rest) => {
    if (!oku && !man) return m;
    return String(Number(oku || 0) * 1e8 + Number(man || 0) * 1e4 + Number(rest || 0));
  });
}

/**
 * 記事に出てくる数値が、論文の本文にあるかを確かめる。見つからない数値の一覧を返す。
 * 1桁の整数（「6つの観点」「4年生」など）は数えない。小数は .21 と 0.21 のどちらでも探す。
 */
function checkNumbers(article, paperText, opts = {}) {
  const hay = stripThousands(paperText).replace(/[−–]/g, '-');
  const prose = config.sections.map((s) => article.sections[s.key]).join('\n') +
                '\n' + (article.nextReads || []).map((n) => n.reason).join('\n');
  const found = expandManUnits(stripThousands(prose)).match(/\d+(?:\.\d+)?/g) || [];
  const bad = [];
  // opts.allowSums === false なら和を許さない（図の語句の照合。偶然の一致で作られた数を通さないため）
  const sums = opts.allowSums === false ? new Set() : pairSums(hay);
  found.forEach((n) => {
    if (/^\d$/.test(n) || bad.includes(n)) return;
    // 本文にある2つの整数の和（77名＋71名＝148名）は、記事の書き手が合計した値として許す
    if (/^\d+$/.test(n) && sums.has(Number(n))) return;
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

/**
 * 字数が範囲外の観点。超過は少し許す（書き直しの往復を減らすため）が、不足は許さない。
 * 下限を 0.9 倍（135字）にしていたら、(1)〜(5) が 146〜184 字の薄い記事が警告なしで通った（2026-10-04）
 */
function sectionsOutOfRange(article) {
  const lo = config.sectionMinChars;
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
  writeArticle, buildPrompt, articleSchema, normalize, citationFields, checkNumbers,
  sectionLength, sectionsOutOfRange, fixSectionLengths
};
