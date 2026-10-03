/**
 * GAS 版の台帳（Google スプレッドシートを CSV で書き出したもの）を data/ledger.json に引き継ぐ。1回だけ使う
 *
 *   node import-gas-ledger.js <台帳.csv>
 *
 * 引き継ぐのは論文 ID・DOI・原題・和訳タイトル・GAS での状態だけ。すべて「imported」にして、
 * 二度と取りに行かないようにする（GAS で投稿済みの論文を、こちらで二重に紹介しないため）。
 * GAS に投稿待ち（記事完成）が残っていた場合は、ここでは引き継がない（そのときは GAS で出し切ってから移す）。
 */
const fs = require('fs');
const store = require('./lib/store');

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function parseCsv(s) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const file = process.argv[2];
if (!file) { console.error('使い方: node import-gas-ledger.js <台帳.csv>'); process.exit(1); }

const rows = parseCsv(stripBom(fs.readFileSync(file, 'utf8')));
const head = rows[0];
const col = (name) => head.indexOf(name);
const need = ['論文ID(OpenAlex)', 'DOI', 'ステータス', '原題', '和訳タイトル', 'ブログ投稿日時'];
need.forEach((n) => { if (col(n) === -1) throw new Error('列が見つかりません: ' + n); });

const ledger = store.loadLedger();
let added = 0;
const pending = [];
rows.slice(1).forEach((r) => {
  const id = String(r[col('論文ID(OpenAlex)')] || '').trim();
  if (!id) return;
  const gasStatus = r[col('ステータス')];
  if (!['完了', '対象外', 'ブログ投稿済み'].includes(gasStatus)) pending.push(gasStatus + ' ' + id);
  if (ledger.papers[id]) return;
  ledger.papers[id] = {
    doi: r[col('DOI')], title: r[col('原題')], titleJa: r[col('和訳タイトル')],
    status: store.STATUS.IMPORTED, gasStatus, gasPublishedAt: r[col('ブログ投稿日時')]
  };
  added++;
});
store.saveLedger(ledger);
console.log('引き継ぎ: ' + added + ' 件（台帳の合計 ' + Object.keys(ledger.papers).length + ' 件）');
if (pending.length) console.warn('GAS で投稿が済んでいない行があります（引き継いだので、こちらでは記事にしません）:\n  ' + pending.join('\n  '));
