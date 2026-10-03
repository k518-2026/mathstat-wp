/**
 * .env を読む（手元の PC 用。GitHub Actions では Secrets が環境変数で渡る）。
 * すでに環境変数にあるものは上書きしない。外部パッケージに頼らないための小さな実装
 */
const fs = require('fs');
const path = require('path');

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function loadEnv(file) {
  const p = file || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  // PowerShell で作ると先頭に BOM が付くことがある
  stripBom(fs.readFileSync(p, 'utf8')).split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) return;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}

module.exports = { loadEnv };
