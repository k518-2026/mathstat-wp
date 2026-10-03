# mathstat-wp

算数・数学教育を統計的に分析した海外の論文を、被引用数の多い順に選んで6つの観点で紹介する記事を作り、
WordPress（[教育情報分析研究会 SEDA](https://seda2026.wordpress.com/)）へ毎日2本投稿し、Bluesky で告知する仕組みです。

Google Apps Script 版（PaperIntro / MathStat）の後継です。2026年10月に、役割を2つに分けました。

| 役割 | 動く場所 | ファイル |
|---|---|---|
| 論文を探して記事を作り、貯める | 手元の Windows PC（タスク スケジューラー） | `generate.js` |
| 貯めた記事を WordPress へメールで投稿する（毎日 8時・18時） | GitHub Actions | `publish.js`、`.github/workflows/publish.yml` |
| WordPress に出た記事を Bluesky で告知する | GitHub Actions | `announce.js`、`.github/workflows/announce.yml` |

## 記事の作り方

1. OpenAlex で、オープンアクセス・英語・学術誌の論文を被引用数の多い順に探す（条件は `config.js`）
2. 本文の PDF を取り、`pdftotext` で文字にする
3. 言語モデルに6観点の記事を書かせる。使う順番は次のとおり
   1. **Gemini**（無料）。混雑していれば別の Gemini のモデル、全部駄目なら1分おいてもう一巡
   2. **Mac mini の Ollama**（`qwen2.5:14b`、無料・手元）。一度に読める量が少ないので、論文を区切って事実のメモを作らせ、メモから記事を書かせる
   3. **Claude**（従量課金）。Ollama が使えないとき、または Ollama の記事に論文に無い数値があったとき
4. 記事に出てくる数値が論文の本文にあるかをプログラムで照合する
5. 専門用語に日本語版 Wikipedia へのリンクを付ける（項目が実在し、意味が合うものだけ）
6. `articles/<論文ID>.json` に保存し、`data/ledger.json` に記録して GitHub に push する

投稿待ちが6本（3日分）あれば作りません。PC が数日止まっても、貯めた分で投稿は続きます。

## ファイル

| ファイル | 中身 | 書く側 |
|---|---|---|
| `articles/*.json` | 記事（書誌・6観点・リンク・紹介文） | 手元の PC |
| `data/ledger.json` | 見た論文すべて（作った・対象外・失敗・GAS 版から引き継いだもの） | 手元の PC |
| `data/posted.json` | WordPress に送った日時・記事 URL・Bluesky の投稿 URL | GitHub Actions |

台帳を2つに分けているのは、PC と Actions が同じファイルを書き換えると push がぶつかるためです。

写真は Pixabay から投稿のときに取ってメールに添付します。写真そのものはリポジトリに置きません。

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
| `PIXABAY_API_KEY` | 写真の検索 |
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
