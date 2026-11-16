// Prints the coverage of `npm run coverage` as Markdown: the totals over src/,
// then every src/ file, least covered first. CI appends it to the job summary.
// The report also lists the bundled node_modules helpers; they are left out
// here, totals included.
//
// A file can be reported twice: once through the bundle's source map
// ("youtube-webos/src/speed/wsola.js") and once as itself, when a unit test
// loads it from src/ directly ("src/speed/wsola.js"). Each copy counts only
// what its own tests ran, so the two disagree (wsola.js: 1.5% and 97.7%).
// They are joined into one row: a line counts as covered when either run
// covered it. Functions and branches are placed differently in the two
// (transpiled vs. source), so for those the row takes the better run. Such
// rows are marked.
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '../coverage');
// The floor: coverage over src/ (both builds) below this fails the run, so a
// change cannot take tests away, or add untested code, unnoticed. Raise it
// as coverage grows; it sits a little under the figures it was set at
// (2026-11-16: lines 94.1%, functions 92.5%, branches 82.6%, the same in
// four runs on main in a row).
const FLOOR = { lines: 93.5, functions: 92, branches: 82 };
// Keys look like "youtube-webos/src/ui.js" (the package name, from webpack)
// or "src/ui.js" (a file a test required itself).
const srcName = (file) => file.replace(/\\/g, '/').replace(/^[^/]+\/(?=src\/)/, '');
const isSrc = (name) => /^src\//.test(name) && !name.endsWith('.css');
const pct = (covered, total) => (total ? Math.round((covered / total) * 10000) / 100 : 100);
const metric = (covered, total) => ({ covered, total, pct: pct(covered, total) });

// Line -> hits from the statements that start on it, as the summary counts them.
function lineHits(file) {
  const hits = new Map();
  for (const id of Object.keys(file.statementMap)) {
    const line = file.statementMap[id].start.line;
    hits.set(line, Math.max(hits.get(line) || 0, file.s[id]));
  }
  return hits;
}

function rowsFromDetail(detail, summary) {
  const groups = new Map();
  for (const key of Object.keys(detail)) {
    const name = srcName(key);
    if (!isSrc(name)) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(key);
  }
  const rows = [];
  for (const [name, keys] of groups) {
    const lines = new Map();
    for (const key of keys) {
      for (const [line, hits] of lineHits(detail[key])) lines.set(line, Math.max(lines.get(line) || 0, hits));
    }
    let covered = 0;
    for (const hits of lines.values()) if (hits > 0) covered++;
    const better = (m) => keys.map((k) => summary[k][m]).sort((a, b) => b.pct - a.pct)[0];
    rows.push({ name, joined: keys.length > 1, lines: metric(covered, lines.size),
      functions: better('functions'), branches: better('branches') });
  }
  return rows;
}

// Without coverage-final.json (an older c8 config): the best copy of each file.
function rowsFromSummary(summary) {
  const best = new Map();
  for (const key of Object.keys(summary)) {
    const name = srcName(key);
    if (!isSrc(name)) continue;
    const row = { name, joined: false, ...summary[key] };
    const seen = best.get(name);
    if (!seen) best.set(name, row);
    else best.set(name, { ...(row.lines.pct > seen.lines.pct ? row : seen), joined: true });
  }
  return [...best.values()];
}

const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'coverage-summary.json'), 'utf8'));
const detailFile = path.join(DIR, 'coverage-final.json');
const rows = (fs.existsSync(detailFile)
  ? rowsFromDetail(JSON.parse(fs.readFileSync(detailFile, 'utf8')), summary)
  : rowsFromSummary(summary)
).sort((a, b) => a.lines.pct - b.lines.pct || a.name.localeCompare(b.name));

// An empty report (no src/ file measured) would read as 100% and pass any floor.
if (!rows.length || !rows.some((r) => r.lines.total > 0)) {
  console.error('coverage-summary: no src/ file with executable lines in the report');
  process.exit(1);
}

const share = (m) => {
  let covered = 0, all = 0;
  for (const r of rows) { covered += r[m].covered; all += r[m].total; }
  return all ? (covered / all) * 100 : 100;
};
const total = (m) => `${Math.round(share(m) * 10) / 10}%`;

console.log('## Test coverage (legacy and modern builds)\n');
console.log(`Lines **${total('lines')}** · functions **${total('functions')}** · branches **${total('branches')}** (${rows.length} files in src/)\n`);
console.log('| File | Lines | Functions | Branches |');
console.log('|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.name}${r.joined ? ' ¹' : ''} | ${r.lines.pct}% (${r.lines.covered}/${r.lines.total}) | ${r.functions.pct}% | ${r.branches.pct}% |`);
}
if (rows.some((r) => r.joined)) {
  console.log('\n¹ Loaded by the bundle and by a unit test directly: lines covered by either run, functions and branches from the better one.');
}

const below = Object.keys(FLOOR).filter((m) => share(m) < FLOOR[m]);
if (below.length) {
  console.log(`\n**Below the floor:** ${below.map((m) => `${m} ${total(m)} (floor ${FLOOR[m]}%)`).join(', ')}.`);
  process.exitCode = 1;
}
