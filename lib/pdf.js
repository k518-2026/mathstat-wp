/**
 * 本文 PDF の取得と文字起こし
 *
 * ・pdf_url があっても実際に PDF が返るのは6〜7割。出版社は 403 や HTML のログイン画面を返すので、
 *   **先頭4バイトが %PDF か**を必ず確かめる
 * ・文字起こしは poppler の pdftotext（Windows では Git for Windows に入っているもの。場所は config.pdftotext）。
 *   -layout は付けない（段組みが崩れた行になるより、素直な読み順のほうが要約に向く）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchRetry } = require('./http');
const config = require('../config');

function isPdf(buf) {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

/**
 * リダイレクトを自分でたどり、途中で受け取った Cookie を次の要求に付ける。
 * Springer は認証サーバーを経由して Cookie を付けてから PDF を返す。fetch の自動リダイレクトは
 * Cookie を持ち越さないので、HTML の中継ページで止まっていた（2026-10-04）
 */
async function fetchWithCookies(url) {
  const jar = {};
  let current = url;
  for (let i = 0; i < 10; i++) {
    const cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
    const res = await fetchRetry(current, {
      headers: { Accept: 'application/pdf', ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'manual'
    }, { attempts: 2, timeoutMs: 90000 });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
      const kv = c.split(';')[0];
      const at = kv.indexOf('=');
      if (at > 0) jar[kv.slice(0, at).trim()] = kv.slice(at + 1);
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('リダイレクトが多すぎます');
}

/** PDF を取ってくる。取れなければ null（理由はログに出す） */
async function fetchPdf(paper) {
  const tried = [];
  for (const url of paper.pdfUrls) {
    try {
      const res = await fetchWithCookies(url);
      if (!res.ok) { tried.push(res.status + ' ' + url); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isPdf(buf)) { tried.push('PDFではない ' + url); continue; }
      if (buf.length > config.pdfMaxBytes) {
        tried.push('大きすぎる(' + Math.round(buf.length / 1048576) + 'MB) ' + url);
        continue;
      }
      return { buf, url, bytes: buf.length };
    } catch (e) {
      tried.push('通信失敗 ' + url + ' ' + e.message);
    }
  }
  console.log('  PDF を取得できませんでした:\n    ' + (tried.join('\n    ') || '候補なし'));
  return null;
}

/** pdftotext で文字にする。取れなければ空文字 */
function extractText(pdf) {
  const file = path.join(os.tmpdir(), 'mathstat-' + process.pid + '-' + Date.now() + '.pdf');
  fs.writeFileSync(file, pdf.buf);
  try {
    const out = execFileSync(config.pdftotext,['-q', '-enc', 'UTF-8', file, '-'], {
      maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'
    });
    return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) {
    console.warn('  pdftotext に失敗: ' + e.message.slice(0, 200));
    return '';
  } finally {
    try { fs.unlinkSync(file); } catch { /* 消せなくても続ける */ }
  }
}

/** 参考文献リストから後ろを落とす（Gemini に渡す量を減らす） */
function dropReferenceList(text) {
  const m = String(text).match(/\n\s*(references|bibliography|literature cited|参考文献)\s*\n/i);
  if (!m || m.index < text.length * 0.3) return text;   // 前の方にある見出しは本文の一部
  return text.slice(0, m.index);
}

module.exports = { fetchPdf, extractText, dropReferenceList, isPdf };
