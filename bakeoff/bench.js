'use strict';
/**
 * bench.js - one core's .wasm on one game, measured the way the app would run it (app/snes-core.js), on
 * whatever Node runs this file. For the numbers that count, that is Node 8 (tools/node8.js), the head unit's.
 *
 *   node bakeoff/bench.js <core.wasm> <game.sfc> [--frames 3000] [--warm 300] [--pads keys | --mash [seed]]
 *        [--var key=value]... [--hash] [--shots <folder> [--every 300]] [--pads-out <file>] [--state] [--json]
 *
 * What it reports: how long WebAssembly.compile took, the .wasm's size, then for the frames after the warm-up
 * the milliseconds one frame took (mean, median, 99th percentile, worst), the picture's size (and whether it
 * changed), the sound's rate and samples a frame, the core's memory and the process's, and what a save state
 * weighs and costs.
 *
 *   --pads  "120:START,124:,400:RIGHT+B"   from that frame on, these buttons are held
 *   --mash  Start now and then for the first 20 s, to get past a title; then directions and buttons from a
 *           fixed sequence (the same every run, and the same for the native build: --pads-out writes it)
 *   --hash  a hash over every picture and all the sound, for bakeoff/verify.js (costs time: not with timing)
 *   --shots PNGs of the picture, to see what was measured
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Snes, BTN, romInfo } = require('../app/snes-core');

function args(argv) {
    const o = { frames: 3000, warm: 300, vars: {}, every: 300, _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--frames') o.frames = +argv[++i];
        else if (a === '--warm') o.warm = +argv[++i];
        else if (a === '--pads') o.pads = argv[++i];
        else if (a === '--mash') { o.mash = 1; if (/^\d+$/.test(argv[i + 1] || '')) o.mash = +argv[++i]; }
        else if (a === '--var') { const kv = argv[++i].split('='); o.vars[kv[0]] = kv.slice(1).join('='); }
        else if (a === '--hash') o.hash = true;
        else if (a === '--shots') o.shots = argv[++i];
        else if (a === '--every') o.every = +argv[++i];
        else if (a === '--pads-out') o.padsOut = argv[++i];
        else if (a === '--hashes-out') o.hashesOut = argv[++i];
        else if (a === '--state') o.state = true;
        else if (a === '--json') o.json = true;
        else o._.push(a);
    }
    return o;
}

/** the buttons held in each frame: a Uint16Array of libretro joypad masks */
function schedule(o) {
    const pads = new Uint16Array(o.frames);
    if (o.pads) {
        const steps = o.pads.split(',').map((s) => { const p = s.split(':'); return [+p[0], (p[1] || '').split('+').reduce((m, k) => m | (BTN[k.trim().toUpperCase()] || 0), 0)]; });
        let m = 0, k = 0;
        for (let f = 0; f < o.frames; f++) { while (k < steps.length && steps[k][0] <= f) m = steps[k++][1]; pads[f] = m; }
    } else if (o.mash) {
        let s = (o.mash * 2654435761) >>> 0, m = 0;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 8; };
        const dirs = [BTN.RIGHT, BTN.RIGHT, BTN.RIGHT, BTN.LEFT, BTN.UP, BTN.DOWN, BTN.RIGHT | BTN.UP, BTN.RIGHT | BTN.DOWN, 0];
        const keys = [BTN.B, BTN.Y, BTN.A, BTN.X, BTN.L, BTN.R];
        for (let f = 0; f < o.frames; f++) {
            if (f < 1200) {                                           // titles and menus: Start, and A between
                const t = f % 90;
                m = t >= 60 && t < 64 ? BTN.START : t >= 20 && t < 24 ? BTN.A : t >= 40 && t < 44 ? BTN.B : 0;
            } else if (f % 12 === 0) {
                m = dirs[rnd() % dirs.length];
                if (rnd() % 3) m |= keys[rnd() % keys.length];
                if (rnd() % 5 === 0) m |= keys[rnd() % keys.length];
            }
            pads[f] = m;
        }
    }
    return pads;
}

/* ---------- a PNG of an RGBA picture ---------- */
let crcTable = null;
function crc32(b) {
    if (!crcTable) { crcTable = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; } }
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function png(px, w, h) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc32(b.slice(4, 8 + data.length)), 8 + data.length); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d); } }

const ms = (t) => { const d = process.hrtime(t); return d[0] * 1000 + d[1] / 1e6; };
const round = (x, n) => { const k = Math.pow(10, n === undefined ? 3 : n); return Math.round(x * k) / k; };

function bench(o) {
    const wasm = o._[0], romFile = o._[1];
    const rom = fs.readFileSync(romFile);
    const info = romInfo(rom);
    const quiet = { info() { }, warn() { }, error(a, b) { console.error(a, b || ''); }, debug() { } };
    const lines = [];
    const log = { info(s) { lines.push(s); }, warn(s) { lines.push(s); }, error(a, b) { lines.push(String(a) + ' ' + (b || '')); }, debug() { } };
    const snes = new Snes({ wasm, log: o.verbose ? console : log, now: () => 1e12 });   // (a fixed clock: the same run every time)
    const r = { node: process.version, wasm: path.basename(wasm), wasmBytes: fs.statSync(wasm).size, rom: path.basename(romFile), romBytes: rom.length, header: info ? info.mapping + ' "' + info.title + '" chip ' + info.chip : null };
    const rss0 = process.memoryUsage().rss;
    let t = process.hrtime();
    return snes.compile().then(() => {
        r.compileMs = round(ms(t), 0);
        Object.keys(o.vars).forEach((k) => snes.setVar(k, o.vars[k]));
        t = process.hrtime();
        const ok = snes.load(rom);
        r.loadMs = round(ms(t), 1);
        if (!ok) { r.error = 'the core did not take the game' + (snes.dead ? ': ' + snes.dead.message : ''); r.log = lines.slice(-6); return r; }
        r.memAtLoad = snes.mem.buffer.byteLength;
        r.fps = snes.fps; r.sampleRate = snes.sampleRate;
        const pads = schedule(o);
        if (o.padsOut) fs.writeFileSync(o.padsOut, Buffer.from(pads.buffer));
        const times = new Float64Array(o.frames);
        const sizes = {};
        let hv = 2166136261 >>> 0, ha = 2166136261 >>> 0, samples = 0, pictures = 0, last = null;
        r.checks = [];
        const each = new Uint32Array(o.hash ? o.frames * 2 : 0);
        if (o.shots) mkdirp(o.shots);
        for (let f = 0; f < o.frames; f++) {
            snes.setPad(0, pads[f]);
            const t0 = process.hrtime();
            const got = snes.run();
            times[f] = ms(t0);
            if (snes.dead) { r.error = 'the core crashed in frame ' + f + ': ' + snes.dead.message; break; }
            if (got) pictures++;
            const fr = snes.frame(), au = snes.audio();
            if (fr) { last = fr.w + 'x' + fr.h; sizes[last] = (sizes[last] || 0) + 1; }
            if (au) samples += au.frames;
            if (o.hash) {
                // this frame's picture and its sound, each hashed by itself (for --hashes-out), and those chained
                let pv = 2166136261 | 0, pa = 2166136261 | 0;
                if (fr) { const u = new Uint32Array(fr.px.buffer, fr.px.byteOffset, fr.w * fr.h); for (let i = 0; i < u.length; i++) pv = Math.imul(pv ^ u[i], 16777619); pv = Math.imul(pv ^ ((fr.w << 16) | fr.h), 16777619); }
                if (au) { const u = new Uint16Array(au.bytes.buffer, au.bytes.byteOffset, au.frames * 2); for (let i = 0; i < u.length; i++) pa = Math.imul(pa ^ u[i], 16777619); pa = Math.imul(pa ^ au.frames, 16777619); }
                hv = Math.imul(hv ^ pv, 16777619) >>> 0; ha = Math.imul(ha ^ pa, 16777619) >>> 0;
                each[f * 2] = pv >>> 0; each[f * 2 + 1] = pa >>> 0;
                if ((f + 1) % 300 === 0 || f + 1 === o.frames) r.checks.push((f + 1) + ' ' + (last || '-') + ' ' + ('0000000' + (hv >>> 0).toString(16)).slice(-8) + ' ' + ('0000000' + (ha >>> 0).toString(16)).slice(-8));
            }
            if (o.shots && fr && ((f + 1) % o.every === 0 || f + 1 === o.frames)) fs.writeFileSync(path.join(o.shots, path.basename(romFile).replace(/\.[^.]+$/, '') + '-' + ('00000' + (f + 1)).slice(-5) + '.png'), png(fr.px, fr.w, fr.h));
        }
        if (!o.hash) delete r.checks;
        else if (o.hashesOut) fs.writeFileSync(o.hashesOut, Buffer.from(each.buffer));
        const n = o.frames - o.warm, s = Array.prototype.slice.call(times, o.warm).sort((a, b) => a - b);
        let sum = 0; for (let i = 0; i < n; i++) sum += s[i];
        r.frames = o.frames; r.pictures = pictures; r.sizes = sizes;
        r.meanMs = round(sum / n); r.medianMs = round(s[n >> 1]); r.p99Ms = round(s[Math.min(n - 1, Math.floor(n * 0.99))]); r.worstMs = round(s[n - 1]);
        r.firstMs = round(times[0]);
        let over = 0; for (let i = 0; i < n; i++) if (s[i] > 2 * r.medianMs) over++;
        r.overTwiceMedian = over;
        r.samplesPerFrame = round(samples / o.frames, 2);
        if (o.state && !snes.dead) {
            let st = null;
            const t1 = process.hrtime();
            for (let i = 0; i < 20; i++) st = snes.saveState();
            r.stateMs = round(ms(t1) / 20);
            r.stateBytes = st ? st.length : 0;
            const t2 = process.hrtime();
            const back = st ? snes.loadState(st) : false;
            r.stateLoadMs = round(ms(t2));
            r.stateLoads = back;
            if (st) r.stateDeflated = zlib.deflateSync(st, { level: 1 }).length;
            const sr = snes.sram();
            r.sramBytes = sr ? sr.length : 0;
        }
        r.memEnd = snes.mem.buffer.byteLength;
        const mu = process.memoryUsage();
        r.rssMB = round(mu.rss / 1048576, 1); r.rssGrewMB = round((mu.rss - rss0) / 1048576, 1);
        if (lines.length) r.log = lines.filter((l) => !/emulator compiled/.test(l)).slice(0, 8);
        return r;
    });
}

module.exports = { bench, schedule, png, args };

if (require.main === module) {
    const o = args(process.argv.slice(2));
    if (o._.length < 2) { console.error('usage: node bakeoff/bench.js <core.wasm> <game.sfc> [options]'); process.exit(2); }
    bench(o).then((r) => {
        if (o.json) { console.log(JSON.stringify(r)); return; }
        Object.keys(r).forEach((k) => console.log((k + ':              ').slice(0, 18) + (typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k])));
    }).catch((e) => { console.error(e); process.exit(1); });
}
