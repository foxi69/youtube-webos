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

function fromCode(file) {
  const code = fs.readFileSync(file, 'utf8');
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
  return { bundle: path.basename(file).replace(/^\d+_/, ''), bytes: code.length, anchors };
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

function diff(a, b) {
  const changes = [];
  const ac = (a.code && a.code.anchors) || {};
  const bc = (b.code && b.code.anchors) || {};
  for (const name of new Set([...Object.keys(ac), ...Object.keys(bc)])) {
    const x = ac[name] ? ac[name].count : 0;
    const y = bc[name] ? bc[name].count : 0;
    if ((x > 0) !== (y > 0)) changes.push(`code: "${name}" ${x > 0 ? 'is gone' : 'is new'} (${x} -> ${y})`);
    else if (x !== y) changes.push(`code: "${name}" found ${x} -> ${y} times`);
  }
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

function main(argv) {
  const [cmd, x, y] = argv;
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
  console.error('usage: yt-tv-snapshot.cjs build <dir> [out.json] | diff <old.json> <new.json>');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { build, diff, commandShape };
