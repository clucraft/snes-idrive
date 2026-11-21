'use strict';
/**
 * verify.js - a core's .wasm under Node 8 against the same sources built for this computer, picture for
 * picture and sample for sample:
 *
 *   node bakeoff/verify.js <core> [-Os|-O2] [--frames 1500] [--mash] <game.sfc>...
 *
 * Both get the same game and the same buttons (bench.js --pads-out), and both print a hash over every picture
 * and all the sound so far every 300 frames (bench.js --hash, native_main.c). One line that differs is a
 * failure. Needs both builds: node bakeoff/build.js <core> [-Ox], and --native.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OUT, ROOT } = require('./build');

const WIN = process.platform === 'win32';
function node8() {
    const name = 'node-v8.17.0-' + (WIN ? 'win' : process.platform) + '-x64';
    const bin = path.join(ROOT, '.cache', name, WIN ? 'node.exe' : path.join('bin', 'node'));
    if (!fs.existsSync(bin)) throw new Error('Node 8 is not in .cache yet: node tools/node8.js -v');
    return bin;
}

function verify(core, opt, rom, frames, mash, vars) {
    const pads = path.join(OUT, 'pads-' + process.pid + '.bin');
    const wasm = path.join(OUT, core + opt + '.wasm'), native = path.join(OUT, core + '-native' + (WIN ? '.exe' : ''));
    const varArgs = [];
    (vars || []).forEach((v) => { varArgs.push('--var', v); });
    const hw = path.join(OUT, 'hashes-w-' + process.pid + '.bin'), hn = path.join(OUT, 'hashes-n-' + process.pid + '.bin');
    const clean = () => [pads, hw, hn].forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* none */ } });
    const a = spawnSync(node8(), [path.join(__dirname, 'bench.js'), wasm, rom, '--frames', String(frames), '--hash', '--json', '--pads-out', pads, '--hashes-out', hw].concat(mash ? ['--mash'] : [], varArgs), { maxBuffer: 1 << 26 });
    if (a.status !== 0) { clean(); return { ok: false, why: 'the .wasm run failed: ' + String(a.stderr).slice(0, 300) }; }
    const w = JSON.parse(a.stdout.toString());
    if (w.error) { clean(); return { ok: false, why: 'wasm: ' + w.error }; }
    const b = spawnSync(native, [rom, String(frames), pads].concat(vars || []), { maxBuffer: 1 << 26, env: Object.assign({}, process.env, { MGU_HASHES: hn }) });
    if (b.status !== 0) { clean(); return { ok: false, why: 'the native run failed (' + b.status + '): ' + String(b.stdout).slice(0, 200) + String(b.stderr).slice(0, 200) }; }
    const lines = b.stdout.toString().split(/\r?\n/).filter((l) => /^\d+ /.test(l));
    const speed = (/native ms\/frame ([\d.]+)/.exec(b.stdout.toString()) || [])[1];
    // every frame's own two hashes: how many frames differ, and in what
    const x = fs.readFileSync(hw), y = fs.readFileSync(hn);
    clean();
    let pic = 0, snd = 0, first = -1;
    const n = Math.min(x.length, y.length) >> 3;
    for (let f = 0; f < n; f++) {
        const dp = x.readUInt32LE(f * 8) !== y.readUInt32LE(f * 8), ds = x.readUInt32LE(f * 8 + 4) !== y.readUInt32LE(f * 8 + 4);
        if (dp) pic++;
        if (ds) snd++;
        if ((dp || ds) && first < 0) first = f + 1;
    }
    const same = x.length === y.length && !pic && !snd && lines.join('\n') === w.checks.join('\n');
    if (!same) return { ok: false, pic, snd, first, why: pic + ' of ' + n + ' pictures and ' + snd + ' frames of sound differ, the first in frame ' + first, nativeMs: speed };
    return { ok: true, last: w.checks[w.checks.length - 1], nativeMs: speed, wasmMs: w.meanMs };
}

module.exports = { verify, node8 };

if (require.main === module) {
    const a = process.argv.slice(2);
    let frames = 1500, opt = '-Os', mash = false;
    const rest = [], vars = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--frames') frames = +a[++i];
        else if (a[i] === '--mash') mash = true;
        else if (a[i] === '--var') vars.push(a[++i]);
        else if (/^-O/.test(a[i])) opt = a[i];
        else rest.push(a[i]);
    }
    const core = rest.shift();
    let bad = 0;
    rest.forEach((rom) => {
        const r = verify(core, opt, rom, frames, mash, vars);
        if (!r.ok) bad++;
        console.log((r.ok ? 'same  ' : 'DIFF  ') + path.basename(rom) + (r.ok ? '  ' + r.last : '  ' + r.why) + (r.nativeMs ? '  (native ' + r.nativeMs + ' ms/frame)' : ''));
    });
    console.log(core + opt + ': ' + (rest.length - bad) + ' of ' + rest.length + ' the same over ' + frames + ' frames');
    process.exit(bad ? 1 : 0);
}
