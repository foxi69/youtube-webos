#!/usr/bin/env node
/**
 * What youtube.com/tv sends and does that the app's preview fixes rely on,
 * kept as a snapshot, so that a change on YouTube's side shows at once.
 *
 *   node tools/yt-tv-snapshot.cjs build <dir> [out.json]
 *       <dir> holds a capture from the TV: the main bundle (`*main.js`) and
 *       InnerTube responses (`*.json`, browse and player). Writes the snapshot
 *       (default: stdout). Nothing that identifies a viewer is kept: no
 *       tracking params, tokens, visitor data, titles or ids, only field
 *       names, the preview command's values and the code around the names.
 *   node tools/yt-tv-snapshot.cjs diff <old.json> <new.json>
 *       Lists what changed; exits 1 when something did.
 *   node tools/yt-tv-snapshot.cjs watch-code <snapshot.json> [--write]
 *       With no TV: downloads youtube.com/tv's public main bundle and compares
 *       the names in it with the snapshot's. Exits 0 (no change), 1 (changed)
 *       or 2 (not fetched). --write takes the new counts into the snapshot.
 *       The server's data (the preview command) needs a capture from a TV.
 *
 * The stored one is bench/fixtures/yt-tv-snapshot.json. A capture can be
 * taken over CDP: the bundle with Debugger.getScriptSource, the responses
 * with Network.getResponseBody while browsing Home.
 */
const fs = require('fs');
const path = require('path');

// Names in YouTube's code the app's preview fixes depend on (adblock.js,
// player-animation.js, mute-previews.js) or that explain them.
const CODE_ANCHORS = [
  'blockAdoption',
  'blockAdoptionFromWatch',
  'forceSeamlessAutotransition',
  'autotransitionDelayMs',
  'disableInlineAdoption',
  'restartPlaybackBeforeSeconds',
  'supportsPlayerResizeAnimation',
  'setInlineAutotransitionTime',
  'startInlinePlaybackCommand',
  'graftPlayback',
  'preloadWatchPageFromPreviewDelayMs',
  'fadeoutDurationMs',
  'inline_playback'
];
const SNIPPET = 160;

function walk(node, visit, depth = 0, keyPath = '$') {
  if (!node || typeof node !== 'object' || depth > 60) return;
  visit(node, keyPath, depth);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') walk(v, visit, depth + 1, keyPath + '.' + (Array.isArray(node) ? '[]' : k));
  }
}

// A preview command's values: scalars as they are, objects as their keys.
function commandShape(cmd) {
  const out = {};
  for (const k of Object.keys(cmd).sort()) {
    const v = cmd[k];
    if (v === null || typeof v !== 'object') out[k] = typeof v === 'string' ? '<string>' : v;
    else out[k] = '{' + Object.keys(v).sort().join(',') + '}';
  }
  return out;
}

function fromResponses(files) {
  const commands = {};
  const commandPaths = {};
  const tileKeys = {};
  let responses = 0;
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object' || (!data.contents && !data.continuationContents)) continue;
    responses++;
    walk(data, (node, keyPath) => {
      if (node.startInlinePlaybackCommand && typeof node.startInlinePlaybackCommand === 'object') {
        const sig = JSON.stringify(commandShape(node.startInlinePlaybackCommand));
        commands[sig] = (commands[sig] || 0) + 1;
        const p = keyPath.replace(/^\$\.(contents|continuationContents)\.[^.]+/, '$1:…').split('.').slice(-4).join('.');
        commandPaths[p] = (commandPaths[p] || 0) + 1;
      }
      if (node.tileRenderer && typeof node.tileRenderer === 'object') {
        const sig = Object.keys(node.tileRenderer).sort().join(',');
        tileKeys[sig] = (tileKeys[sig] || 0) + 1;
      }
    });
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return {
    responses,
    previewCommands: Object.entries(sortObj(commands)).map(([sig, count]) => ({ count, fields: JSON.parse(sig) })),
    previewCommandPaths: sortObj(commandPaths),
    tileRendererKeys: sortObj(tileKeys)
  };
}

function codeAnchors(code) {
  const anchors = {};
  for (const name of CODE_ANCHORS) {
    let count = 0;
    let first = -1;
    for (let i = code.indexOf(name); i !== -1; i = code.indexOf(name, i + 1)) {
      count++;
      if (first === -1) first = i;
    }
    anchors[name] = {
      count,
      // Minified names change with every build: the snippet is for reading,
      // the diff compares the count and the presence.
      snippet: first === -1 ? null : code.slice(Math.max(0, first - SNIPPET / 2), first + SNIPPET).replace(/\s+/g, ' ')
    };
  }
  return anchors;
}

function fromCode(file) {
  const code = fs.readFileSync(file, 'utf8');
  return { bundle: path.basename(file).replace(/^\d+_/, ''), bytes: code.length, anchors: codeAnchors(code) };
}

function build(dir) {
  const names = fs.readdirSync(dir);
  const bundle = names.find((n) => /main\.js$/.test(n));
  const jsons = names.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  return {
    taken: new Date().toISOString().slice(0, 10),
    code: bundle ? fromCode(path.join(dir, bundle)) : null,
    ...fromResponses(jsons)
  };
}

// What changed in how often YouTube's code has each name.
function diffCode(ac, bc) {
  const changes = [];
  for (const name of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
    const x = ac[name] ? ac[name].count : 0;
    const y = bc[name] ? bc[name].count : 0;
    if ((x > 0) !== (y > 0)) changes.push(`code: "${name}" ${x > 0 ? 'is gone' : 'is new'} (${x} -> ${y})`);
    else if (x !== y) changes.push(`code: "${name}" found ${x} -> ${y} times`);
  }
  return changes;
}

function diff(a, b) {
  const changes = diffCode((a.code && a.code.anchors) || {}, (b.code && b.code.anchors) || {});
  const fieldsOf = (s) => {
    const all = {};
    for (const c of s.previewCommands || []) for (const [k, v] of Object.entries(c.fields)) (all[k] = all[k] || new Set()).add(JSON.stringify(v));
    return all;
  };
  const fa = fieldsOf(a);
  const fb = fieldsOf(b);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (!fa[k]) changes.push(`preview command: new field ${k} = ${[...fb[k]].join(' | ')}`);
    else if (!fb[k]) changes.push(`preview command: field ${k} is gone (was ${[...fa[k]].join(' | ')})`);
    else {
      const was = [...fa[k]].sort().join(' | ');
      const now = [...fb[k]].sort().join(' | ');
      if (was !== now) changes.push(`preview command: ${k} ${was} -> ${now}`);
    }
  }
  const pa = Object.keys(a.previewCommandPaths || {});
  const pb = Object.keys(b.previewCommandPaths || {});
  for (const p of pb) if (!pa.includes(p)) changes.push(`preview command found at a new place: ${p}`);
  for (const p of pa) if (!pb.includes(p)) changes.push(`preview command no longer at: ${p}`);
  if ((a.previewCommands || []).length && !(b.previewCommands || []).length)
    changes.push('no preview command in the new capture at all');
  return changes;
}

// ---- Watching the public code, with no TV (the daily workflow) ----

const TV_PAGE = 'https://www.youtube.com/tv';
// What a webOS 25 TV sends; youtube.com/tv serves TVs their own bundle.
const TV_UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.211 ' +
  'Safari/537.36 WebAppManager LG Browser/8.00.00 (webOS.TV-2025), _TV_O18/33.31.75 (LG, OLED65C5.AEU, wireless)';
const FETCH_TIMEOUT_MS = 30000;

/** The main bundle's URL from the page: the base bundle's, with m=main. Null when the page has none. */
function mainBundleUrl(html) {
  const m = /\/s\/_\/kabuki\/_\/js\/[^"'\s\\]+\/m=base/.exec(html);
  return m ? 'https://www.youtube.com' + m[0].replace(/\/m=base$/, '/m=main') : null;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': TV_UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url.split('?')[0].slice(0, 80)}: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads today's bundle and compares its names with the stored snapshot's
 * publicCode: the bundle served to a plain download holds more modules than
 * the one a TV loads (the snapshot's `code`), so the two have counts of
 * their own. Returns { status: 0 no change | 1 changed | 2 not fetched, report }.
 */
async function watchCode(storedPath, { write = false, fetchFn = fetchText } = {}) {
  const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  const base = stored.publicCode;
  let code;
  let url;
  try {
    url = mainBundleUrl(await fetchFn(TV_PAGE));
    if (!url) throw new Error('youtube.com/tv names no base bundle');
    code = await fetchFn(url);
    if (code.length < 100000) throw new Error(`the bundle is only ${code.length} bytes`);
  } catch (e) {
    return { status: 2, report: `Could not fetch youtube.com/tv's code: ${e.message}` };
  }
  const anchors = codeAnchors(code);
  const changes = base ? diffCode(base.anchors || {}, anchors) : ['no publicCode in the snapshot yet'];
  if (write && changes.length) {
    stored.publicCode = { taken: new Date().toISOString().slice(0, 10), bytes: code.length, anchors };
    fs.writeFileSync(storedPath, JSON.stringify(stored, null, 2) + '\n');
  }
  const lines = [
    `youtube.com/tv's main bundle (${code.length} bytes) against the one stored ${base ? base.taken : '(none)'}:`,
    '',
    ...(changes.length ? changes.map((c) => '- ' + c) : ['No change in the names the preview fixes rely on.'])
  ];
  if (changes.length) {
    lines.push('', 'Check what changed in the code (each name\'s snippet is in the stored snapshot), then run ' +
      '`node tools/yt-tv-snapshot.cjs watch-code bench/fixtures/yt-tv-snapshot.json --write` to take the new counts.');
  }
  return { status: changes.length ? 1 : 0, report: lines.join('\n') };
}

async function main(argv) {
  const [cmd, x, y] = argv;
  if (cmd === 'watch-code' && x) {
    const { status, report } = await watchCode(x, { write: y === '--write' });
    console.log(report);
    return status;
  }
  if (cmd === 'build' && x) {
    const out = JSON.stringify(build(x), null, 2) + '\n';
    if (y) fs.writeFileSync(y, out);
    else process.stdout.write(out);
    return 0;
  }
  if (cmd === 'diff' && x && y) {
    const changes = diff(JSON.parse(fs.readFileSync(x, 'utf8')), JSON.parse(fs.readFileSync(y, 'utf8')));
    if (!changes.length) console.log('no change');
    for (const c of changes) console.log('- ' + c);
    return changes.length ? 1 : 0;
  }
  console.error('usage: yt-tv-snapshot.cjs build <dir> [out.json] | diff <old.json> <new.json> | ' +
    'watch-code <snapshot.json> [--write]');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e);
    process.exit(2);
  });
}
module.exports = { build, diff, diffCode, codeAnchors, commandShape, mainBundleUrl, watchCode };
