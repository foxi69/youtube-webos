/**
 * Builds the playback speed probe (issue #97) into one HTML file:
 *
 *   node tools/speed-probe/build.cjs [out.html]
 *
 * (default dist/speed-probe/index.html). probe.js is bundled with the legacy
 * app build's Babel config, so it runs on Chromium 38 (webOS 3). The samples
 * are inlined as base64; for the chunked tests the Ogg Opus file is split into
 * its packets and the ADTS file into its raw AAC frames here, so the page
 * itself has to wrap them again, the way the speed engine would.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const webpack = require('webpack');

const ROOT = path.resolve(__dirname, '../..');
const SAMPLES = path.join(__dirname, 'samples');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist/speed-probe/index.html'));

/** OpusHead and the audio packets of an Ogg Opus file. */
function parseOggOpus(buf) {
  const packets = [];
  let partial = [];
  let at = 0;
  while (at < buf.length) {
    if (buf.toString('ascii', at, at + 4) !== 'OggS') throw new Error(`Ogg sync lost at ${at}`);
    const nseg = buf[at + 26];
    const lacing = buf.subarray(at + 27, at + 27 + nseg);
    let data = at + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      partial.push(buf.subarray(data, data + lacing[i]));
      data += lacing[i];
      if (lacing[i] < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    at = data;
  }
  const head = packets[0];
  if (head.toString('ascii', 0, 8) !== 'OpusHead') throw new Error('No OpusHead');
  return { channels: head[9], preSkip: head.readUInt16LE(10), audio: packets.slice(2) };
}

/** Raw AAC frames of an ADTS file, and its stream settings. */
function parseAdts(buf) {
  const frames = [];
  let cfg = null;
  let at = 0;
  while (at + 7 <= buf.length) {
    if (buf[at] !== 0xff || (buf[at + 1] & 0xf0) !== 0xf0) throw new Error(`ADTS sync lost at ${at}`);
    const headerLen = buf[at + 1] & 1 ? 7 : 9;
    const aot = ((buf[at + 2] >> 6) & 3) + 1;
    const srIndex = (buf[at + 2] >> 2) & 0xf;
    const channels = ((buf[at + 2] & 1) << 2) | (buf[at + 3] >> 6);
    const len = ((buf[at + 3] & 3) << 11) | (buf[at + 4] << 3) | (buf[at + 5] >> 5);
    if (!cfg) cfg = { aot, srIndex, channels };
    frames.push(buf.subarray(at + headerLen, at + len));
    at += len;
  }
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  return { ...cfg, rate: RATES[cfg.srIndex], frames };
}

function packed(list) {
  return { data: Buffer.concat(list).toString('base64'), sizes: list.map((p) => p.length) };
}

function samplesJson() {
  const read = (f) => fs.readFileSync(path.join(SAMPLES, f));
  const files = {};
  for (const f of ['opus.ogg', 'opus.webm', 'aac.aac', 'aac.m4a', 'aac-frag.mp4']) files[f] = read(f).toString('base64');
  const opus = parseOggOpus(read('opus.ogg'));
  const aac = parseAdts(read('aac.aac'));
  return JSON.stringify({
    files,
    opus: { channels: opus.channels, preSkip: opus.preSkip, ...packed(opus.audio) },
    aac: { aot: aac.aot, srIndex: aac.srIndex, channels: aac.channels, rate: aac.rate, ...packed(aac.frames) }
  });
}

function bundle() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-probe-'));
  return new Promise((resolve, reject) => {
    webpack(
      {
        mode: 'production',
        context: ROOT,
        target: ['web', 'es5'],
        entry: path.join(__dirname, 'probe.js'),
        output: { path: tmp, filename: 'probe.js' },
        module: {
          rules: [
            {
              test: /\.[mc]?[jt]s$/i,
              loader: 'babel-loader',
              exclude: [/node_modules[\\/]core-js/, /node_modules[\\/]webpack[\\/]buildin/],
              resolve: { fullySpecified: false }
            }
          ]
        },
        resolve: { extensions: ['.mjs', '.cjs', '.js', '.json', '.ts'] },
        performance: { hints: false }
      },
      (err, stats) => {
        if (err) return reject(err);
        if (stats.hasErrors()) return reject(new Error(stats.toString('errors-only')));
        const js = fs.readFileSync(path.join(tmp, 'probe.js'), 'utf8');
        fs.rmSync(tmp, { recursive: true, force: true });
        resolve(js);
      }
    );
  });
}

bundle()
  .then((js) => {
    const template = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
    const html = template
      .replace('/*SAMPLES*/', () => samplesJson().replace(/</g, '\\u003c'))
      .replace('/*PROBE*/', () => js.replace(/<\/script/gi, '<\\/script'));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, html);
    console.log(`${path.relative(ROOT, OUT)}: ${Math.round(html.length / 1024)} KiB`);
  })
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
