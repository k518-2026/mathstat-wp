# mathstat-wp

算数・数学教育を統計的に分析した海外の論文を、被引用数の多い順に選んで6つの観点で紹介する記事を作り、
WordPress（[教育情報分析研究会 SEDA](https://seda2026.wordpress.com/)）へ毎朝1本投稿し、Bluesky で告知する仕組みです。

Google Apps Script 版（PaperIntro / MathStat）の後継です。2026年10月に、役割を2つに分けました。

| 役割 | 動く場所 | ファイル |
|---|---|---|
| 論文を探して記事を作り、貯める | 手元の Windows PC（タスク スケジューラー） | `generate.js` |
| 貯めた記事を WordPress へメールで投稿する（毎朝 5時に1本） | GitHub Actions | `publish.js`、`.github/workflows/publish.yml` |
| WordPress に出た記事を Bluesky で告知する | GitHub Actions | `announce.js`、`.github/workflows/announce.yml` |

## 記事の作り方

1. OpenAlex で、オープンアクセス・英語・学術誌の論文を被引用数の多い順に探す（条件は `config.js`）
2. 本文の PDF を取り、`pdftotext` で文字にする
3. 言語モデルに6観点の記事を書かせる。論文の全文を1回で読ませる。使う順番は次のとおり（記事も図も短い問い合わせも同じ順）
   1. **Ollama**（`http://192.168.128.62:11434`。`gemma4:12b`、次に `qwen3.5:9b`。無料・手元）
   2. **LM Studio など OpenAI 互換の API**（`http://192.168.128.16:1234`。入っているモデルを順に最大2個）
   3. **外部 API**: Gemini（無料。混雑・上限なら次のモデルへ）→ Claude（従量課金）。手元の2台が起動していないときの第3候補
   手元の2台は、起動していなければ（届かなければ）その実行では飛ばして次へ回します。
4. 手元のモデルが書いた記事は、数値が論文の本文にあるかをプログラムで照合し、無ければ使わず次の候補で書き直します。
   テーマに合うかは、問いを分けて「はい／いいえ」で答えさせて決めます
5. **研究の流れ図**を作る（下の「図」）
6. `articles/<論文ID>.json` と `images/<論文ID>.png` に保存し、`data/ledger.json` に記録して GitHub に push する

投稿待ちが10本（10日分）あれば作りません。PC が数日止まっても、貯めた分で投稿は続きます。

## 図

記事に付ける画像は、**この PC の LuaLaTeX で作る「研究の流れ図」だけ**です（Pixabay の写真は使いません。
イメージよりも、具体的な研究手法の図のほうが価値があるため）。

- 言語モデルが記事の本文から4つの欄（対象／条件・変数／測定・手順／分析と結果）の短い語句を出し、固定のひな形で描きます
- 数値は記事にあるものだけを使い、プログラムで照合します。図には「概念図（実際のデータの図ではありません）」と入れます
- 図が無い記事は、**図ができるまで投稿しません**。記事づくりの実行のたびに、図の無い投稿待ちの記事へ作り直します
- 手で作るとき: `node make-figures.js`（`--id=W…`、`--force`、`--dry`）。一覧で見るとき: `node figures/make-sheet.js`
- LaTeX が要るのはこの PC だけです（TeX Live と LuaTeX-ja）。GitHub Actions は PNG を添付するだけです

## ファイル

| ファイル | 中身 | 書く側 |
|---|---|---|
| `articles/*.json` | 記事（書誌・6観点・紹介文・図の語句） | 手元の PC |
| `images/*.png` | 研究の流れ図（投稿のときに添付する） | 手元の PC |
| `data/ledger.json` | 見た論文すべて（作った・対象外・失敗・GAS 版から引き継いだもの） | 手元の PC |
| `data/posted.json` | WordPress に送った日時・記事 URL・Bluesky の投稿 URL | GitHub Actions |

台帳を2つに分けているのは、PC と Actions が同じファイルを書き換えると push がぶつかるためです。

WordPress に送る本文には、リンクも URL も入れません（書誌は「DOI: 10.xxxx/…」の文字だけ。残っていれば送らずに止めます）。

## 手元の PC の準備

1. Node.js 22 以上と Git for Windows（`pdftotext` が入っている）
2. `npm install`
3. `.env.example` を `.env` という名前でコピーし、鍵を入れる（`.env` は GitHub に送られません）
4. 試す: `node generate.js --dry --force`（記事を1本作ってログに出すだけ）
5. タスク スケジューラーに `run-generate.cmd` を登録する。ログは `logs\generate-日付.log`

## GitHub の準備

Settings → Secrets and variables → Actions に次を登録します。

| 名前 | 中身 |
|---|---|
| `WP_POST_EMAIL` | WordPress のメール投稿用の秘密のアドレス |
| `SMTP_USER` / `SMTP_PASSWORD` | 送信に使う Gmail のアドレスとアプリ パスワード |
| `WP_SITE_URL` | `https://seda2026.wordpress.com` |
| `BLUESKY_HANDLE` / `BLUESKY_PASSWORD` | Bluesky のハンドルとアプリ パスワード |

## 手で動かす

- `node test.js` … 自己検査（通信はすべて偽物）
- `node generate.js --force` … 投稿待ちの本数に関係なく1本作って push
- `node publish.js --dry` … 次に送る記事の件名と本文をログに出す
- Actions の「WordPress に投稿」を手で実行（dry_run にすると送らない）

## 注意

- 記事は AI が論文を要約・翻訳したものです。記事の末尾にもそう書いています
- 本文の PDF はリポジトリに置きません。書誌と被引用数は OpenAlex によります

## ライセンス

MIT（`LICENSE.txt`）
