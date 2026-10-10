/**
 * 記事と台帳の置き場所（リポジトリの中のファイル）
 *
 *   data/ledger.json      … 見た論文すべて（作った・対象外・失敗）。**作る側（この PC）だけが書く**
 *   data/posted.json      … 投稿と告知の記録。**投稿する側（GitHub Actions）だけが書く**
 *   articles/<論文ID>.json … 記事の中身（書誌・6観点・リンク・紹介文）
 *
 * 台帳を2つに分けたのは、PC と Actions が同じファイルを書き換えると git の push がぶつかるため。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const ROOT = path.join(__dirname, '..');

function readJson(rel, fallback) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(rel, value) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const STATUS = {
  READY: 'ready',          // 記事ができた。投稿待ち（posted.json に無ければ）
  REVIEW: 'review',        // 記事はできたが確かめが要る（人が見てから ready にする）
  SKIPPED: 'skipped',      // PDF が取れない・テーマ外。二度と取りに行かない
  RETRY: 'retry',          // 記事作成で失敗。次の実行で先に片付ける
  ERROR: 'error',          // 失敗が続いた
  IMPORTED: 'imported'     // GAS 版の台帳から引き継いだ（投稿済み・対象外）。取りに行かない
};

function loadLedger() {
  return readJson(config.paths.ledger, { papers: {} });
}

function saveLedger(ledger) {
  writeJson(config.paths.ledger, ledger);
}

function loadPosted() {
  return readJson(config.paths.posted, {});
}

function savePosted(posted) {
  writeJson(config.paths.posted, posted);
}

function articlePath(id) {
  return path.join(config.paths.articles, id + '.json');
}

function saveArticle(id, entry) {
  writeJson(articlePath(id), entry);
}

function loadArticle(id) {
  return readJson(articlePath(id), null);
}

/** 重複の判定に使う。論文 ID と DOI のどちらかが台帳にあれば「既知」 */
function isKnown(ledger, paper) {
  if (ledger.papers[paper.id]) return true;
  const doi = String(paper.doi || '').toLowerCase();
  return !!doi && Object.values(ledger.papers).some((p) => String(p.doi || '').toLowerCase() === doi);
}

/** 投稿待ち（記事ができていて、まだ WordPress に送っていないもの）。作った順 */
function queue(ledger, posted) {
  return Object.entries(ledger.papers)
    .filter(([id, p]) => p.status === STATUS.READY && !(posted[id] && posted[id].wpSentAt))
    .sort((a, b) => String(a[1].createdAt).localeCompare(String(b[1].createdAt)))
    .map(([id]) => id);
}

/**
 * 次に投稿する記事。投稿待ちのうち、図のある、いちばん古いもの。
 * 図の無い記事は飛ばす（写真は使わない。図ができれば次の回に出る）。返り値は {id, skipped: [図の無いため飛ばした ID]}
 */
function nextToPost(waiting, hasFigure, preferred) {
  const skipped = [];
  // preferred(id) が true の記事があれば、それを先にする（古い順は保つ）。無ければ、図のある古い順
  const order = typeof preferred === 'function'
    ? waiting.filter(preferred).concat(waiting.filter((id) => !preferred(id)))
    : waiting;
  for (const id of order) {
    if (hasFigure(id)) return { id, skipped };
    skipped.push(id);
  }
  return { id: null, skipped };
}

module.exports = {
  nextToPost, STATUS, ROOT, loadLedger, saveLedger, loadPosted, savePosted, saveArticle, loadArticle, articlePath,
  isKnown, queue, readJson, writeJson
};
