/**
 * 投稿待ちの図を1枚の一覧にする（目で見て確かめる用。リポジトリには images/ の PNG だけを入れ、一覧は入れない）
 *   node figures/make-sheet.js   → figures/_build/sheet/sheet-1.png
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../lib/store');
const config = require('../config');

const ids = store.queue(store.loadLedger(), store.loadPosted()).filter((id) => fs.existsSync(path.join(store.ROOT, 'images', id + '.png')));
const dir = path.join(store.ROOT, 'figures', '_build', 'sheet');
fs.mkdirSync(dir, { recursive: true });

const head = String.raw`\documentclass[a3paper,landscape]{article}
\usepackage[margin=8mm]{geometry}
\usepackage{graphicx}
\pagestyle{empty}
\begin{document}
\centering
`;
const body = ids.map((id, i) => String.raw`\includegraphics[width=0.485\textwidth]{../../../images/${id}.png}` + (i % 2 ? '\\\\\n' : '\\hfill\n')).join('');
fs.writeFileSync(path.join(dir, 'sheet.tex'), head + body + String.raw`\end{document}` + '\n', 'utf8');

execFileSync(config.figure.lualatex, ['-interaction=nonstopmode', '-halt-on-error', 'sheet.tex'], { cwd: dir, stdio: 'pipe', timeout: 120000 });
execFileSync(config.figure.pdftoppm, ['-r', '75', '-png', 'sheet.pdf', 'sheet'], { cwd: dir, stdio: 'pipe', timeout: 60000 });
console.log(ids.length + ' 枚を ' + dir + ' に一覧にしました: ' + fs.readdirSync(dir).filter((f) => /\.png$/.test(f)).join(', '));
