/**
 * 海外論文の紹介「算数・数学教育 × 統計分析」（設定）
 *
 * GAS 版（PaperIntro/MathStat）の後継。2026-10-04 に役割を2つに分けた。
 *
 *   記事を作る … この Windows PC（generate.js）。手元の Ollama → LM Studio → 外部 API（Gemini → Claude）の順に使う
 *   投稿と告知 … GitHub Actions（publish.js / announce.js）。毎朝5時に WordPress へメール投稿し、
 *                RSS に出たのを確かめてから Bluesky で告知する
 *
 * 作った記事は articles/<論文ID>.json に貯め、git で GitHub に送る。
 * Actions はそこから古い順に1本ずつ出す。PC が止まった日も、貯めた分で投稿は続く。
 */

module.exports = {
  name: '海外論文の紹介「算数・数学教育 × 統計分析」',

  // --- 論文の選び方（OpenAlex）。GAS 版と同じ条件 ---
  // T10130 数学教育と指導法 / T11345 数学的能力の認知・発達 / T12522 数学教育と教授法 に、
  // 統計手法の語と学校の語を要旨に含むもの。2026-09-24 時点で約2,560件
  openAlexFilter: 'primary_topic.id:T10130|T11345|T12522,' +
    'title_and_abstract.search:(regression OR "structural equation" OR ANOVA OR multilevel OR "hierarchical linear" OR ' +
    '"factor analysis" OR "meta-analysis" OR longitudinal OR "randomized controlled" OR "statistical analysis"),' +
    'abstract.search:(students OR pupils OR classroom OR teachers OR school OR schools)',
  fromYear: 2010,
  perPage: 50,
  maxSearchPages: 40,
  titleExclude: /\b(Pengaruh|Pembelajaran|terhadap|Siswa|Pengembangan|Kecemasan|Hubungan|Belajar|Matematika)\b/i,

  relevanceRule: '英語で書かれた、算数・数学の学習や指導（幼児期から大学初年次まで）を対象に、' +
    '量的データを統計的に分析した実証研究であること（回帰、構造方程式モデリング、分散分析、マルチレベル分析、' +
    'メタ分析、縦断データの分析など）。脳画像が主題の研究、統計手法そのものの解説、質的研究のみのものは false。',
  writerRole: '数学教育と教育統計に詳しいサイエンスライター',
  reader: '算数・数学の先生や、教育データの分析に関心のある人',

  sections: [
    { key: 'what', heading: '(1) どんな研究か？', guide: 'どんな研究か。対象・目的・規模を具体的に。' },
    { key: 'novelty', heading: '(2) 先行研究と比べてどこがすごいのか？',
      guide: '先行研究と比べてどこが新しく、なぜ重要か。論文自身が述べている位置づけに基づく。' },
    { key: 'method', heading: '(3) 技術や手法のキモはどこにあるか？',
      guide: '手法のキモ。どの統計手法をなぜ選んだか、変数の設定、モデルの組み立てを、統計に詳しくない先生にもわかるように。' },
    { key: 'validation', heading: '(4) どうやって有効だと検証したか？',
      guide: 'どうやって有効だと検証したか。データ・比較の設計・主な結果の数値を、本文に書かれている範囲で。' },
    { key: 'implications', heading: '(5) 現場・実務への示唆と、残された論点',
      guide: '読者にとっての示唆と、論文の限界・残された論点。相関研究や縦断研究の結果から「〜する指導が効果的です」のように' +
        '介入の効果を断定しないこと。「〜の可能性があります」「論文は〜を示唆しています」と書き、論文自身が述べている示唆と、' +
        'あなたの推測を混ぜないこと。' },
    { key: 'nextLead', heading: '(6) 次に読むべき論文はあるか？', lead: true,
      guide: '次に読む論文への導入。**60〜150 字**（後ろに付く論文リストと推薦理由と合わせて観点6の分量になる）。' +
        'どの方向に読み進めるとよいかを具体的に書く。中身のない言い回しで字数を埋めない。論文名は書かない（リストはコードが付ける）。' }
  ],
  sectionMinChars: 150,
  sectionMaxChars: 300,

  // --- 本文 PDF ---
  pdfMaxBytes: 40 * 1024 * 1024,
  pdfTextMinChars: 3000,
  pdfTextMaxChars: 150000,
  // Windows では Git for Windows に入っている pdftotext を使う（タスク スケジューラーからは PATH が通らないことがある）
  pdftotext: process.env.PDFTOTEXT ||
    (process.platform === 'win32' ? 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe' : 'pdftotext'),

  // --- 言語モデル（2026-10-11 ユーザー指示の順番）---
  //   1. Ollama（下の ollama）  2. LM Studio など OpenAI 互換（下の lmstudio）  3. 外部 API: Gemini → Claude
  // 手元の2台が起動していなければ、その実行では飛ばして次へ回す。外部 API は2台が使えないときの第3候補
  temperature: 0.4,
  maxOutputTokens: 16384,

  // 1番目: Ollama。以前の Mac mini（192.168.128.59）に代わって、2026-10-11 から 192.168.128.62
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://192.168.128.62:11434',
    // 入っているモデル（2026-10-11）: gemma4:12b・qwen3.5:9b・shosetsu:latest（小説用と思われるので論文には使わない）。
    // どちらも 26万トークンまで読める。同じ論文（ドリルとエチュード）で比べた結果（2026-10-04、旧サーバー）:
    //   qwen3.5:9b  題名を「豊かなたすき」と誤訳した回があり、ベイズ因子の数値が入らず、
    //               研究1について論文に無い説明（生徒の理解不足）を書いた
    //   gemma4:12b  題名は正しく、数値はすべて論文と一致、研究1の 1.03 も書いた。文章も Gemini に近い
    // 論文紹介は正しさが大事なので、gemma4:12b を先にする。新サーバーでは全文の読み込みが 14秒（旧は 131秒）
    models: (process.env.OLLAMA_MODELS || 'gemma4:12b,qwen3.5:9b').split(','),   // 環境変数で差し替えて比べられる
    fullTextNumCtx: 40960,         // 全文＋指示＋出力（本文 15万字の上限でも約4万トークン）
    composeNumCtx: 12288,          // 短い問い合わせ（用語の確認・字数の書き直し・テーマの判定）
    timeoutMs: 15 * 60 * 1000
  },

  // 2番目: LM Studio など OpenAI 互換の API（/v1/chat/completions）。2026-10-11 に 192.168.128.16:1234 と指定された。
  // 未確認: 指定の時点でこのサーバーは応答せず（起動していない）、入っているモデルと文脈の長さは確かめていない。
  // models が空なら、サーバーが返すモデルを順に最大 autoMax 個使う。文脈の長さは読み込むときに決まり、
  // 論文の全文が入りきらなければ 400 になって次の候補へ回る
  lmstudio: {
    host: process.env.LMSTUDIO_HOST || 'http://192.168.128.16:1234',
    models: process.env.LMSTUDIO_MODELS ? process.env.LMSTUDIO_MODELS.split(',') : [],
    autoMax: 2,
    timeoutMs: 15 * 60 * 1000
  },

  // 3番目: 外部 API。Gemini（無料。混雑・上限なら次のモデルへ）→ Claude（従量課金・1記事 10 円前後）
  geminiModels: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash'],
  // 手元で動かすので GAS の6分の制限は無い。混雑が収まるのを少し待ってから次へ回す
  geminiRounds: 2,
  geminiRoundWaitMs: 60 * 1000,
  claude: {
    model: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 16000
  },

  // --- 次に読む論文 ---
  referenceLookupMax: 80,
  readingFromReferences: 6,
  readingFromCiting: 4,

  // --- 用語リンク ---
  wikiLinkMax: 8,

  // --- 記事 ---
  articleLead: '算数・数学教育を統計的に分析した、海外で多く引用されている論文を6つの観点から紹介します。',
  snsHashtags: ['#数学教育', '#教育統計'],
  // 記事に付ける画像は、この PC で LuaLaTeX で作る「研究の流れ図」だけ（images/<論文ID>.png として GitHub に置く）。
  // Pixabay の写真は 2026-10-11 のユーザー判断でやめた（イメージより、具体的な研究手法の図のほうが価値がある）。
  // 図の無い記事は、図ができるまで投稿しない
  figure: {
    columns: [
      { key: 'target', title: '対象' },
      { key: 'conditions', title: '条件・変数' },
      { key: 'measures', title: '測定・手順' },
      { key: 'results', title: '分析と結果' }
    ],
    maxItems: 3,          // 1つの欄に入れる項目の数
    maxChars: 28,         // 1項目の字数（図の枠に収まる長さ）
    dpi: 170,
    // 図の下に「出典：○○ら（年）。」を付けて書く（figure.sourceNote）
    note: '論文の記述から整理した研究の流れで、実際のデータの図ではありません',
    credit: '論文の記述から作成した研究の流れ図',
    // タスク スケジューラーから動かすときは PATH が通らないので、場所を決めておく
    lualatex: process.env.LUALATEX || (process.platform === 'win32' ? 'C:\\texlive\\2026\\bin\\windows\\lualatex.exe' : 'lualatex'),
    pdftoppm: process.env.PDFTOPPM || (process.platform === 'win32' ? 'C:\\texlive\\2026\\bin\\windows\\pdftoppm.exe' : 'pdftoppm')
  },

  // --- 作る量（generate.js）---
  backlogTarget: 10,       // 投稿待ちがこれだけあれば作らない（1日1本投稿なので10日分）
  maxPerRun: 3,            // 1回の実行で作る上限（手元のモデルで書くと、サーバーが混んでいるとき1本10〜12分かかる）
  maxTriesPerRun: 12,      // 1回の実行で見る候補の数（PDF が取れない・テーマ外を飛ばす）

  // --- WordPress（メール投稿）---
  wordpress: {
    titlePrefix: '【論文紹介】',
    senderName: '論文紹介（算数・数学×統計）',
    category: '論文紹介',
    tags: '論文紹介,数学教育,統計分析',
    draft: false
  },
  // RSS に出てこなければ、この時間まで待ってから告知を見送る
  wpWaitHours: 16,

  paths: {
    articles: 'articles',
    ledger: 'data/ledger.json',     // 作る側（この PC）だけが書く
    posted: 'data/posted.json'      // 投稿する側（Actions）だけが書く。同じファイルを両方で書くと git でぶつかる
  }
};
