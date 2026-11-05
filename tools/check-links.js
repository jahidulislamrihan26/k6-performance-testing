// Checks that every relative link in the Markdown files points to a file that exists.   Usage: node tools/check-links.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', 'test-results', 'playwright-report']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.md')) files.push(p);
  }
})(root);

let total = 0;
const broken = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1];
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    if (!target) continue;
    total++;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(root, file)} -> ${link}`);
  }
}
console.log(`${files.length} Markdown files, ${total} relative links, ${broken.length} broken`);
if (broken.length) { console.log(broken.join('\n')); process.exit(1); }
