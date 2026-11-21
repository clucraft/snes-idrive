'use strict';
/**
 * diff.js - where two builds' pictures part: runs both on one game with the same buttons and names the first
 * frame that differs, how many pixels and in which rows, and writes both pictures as PNGs.
 *
 *   node bakeoff/diff.js <a.wasm> <b.wasm> <game.sfc> [--frames 1500] [--mash] [--out folder]
 */
const fs = require('fs');
const path = require('path');
const { Snes } = require('../app/snes-core');
const { schedule, png, args } = require('./bench');

const o = args(process.argv.slice(2));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const out = o.shots || path.join(__dirname, '..', '.cache', 'diff');
if (!fs.existsSync(out)) fs.mkdirSync(out);
(async () => {
    const rom = fs.readFileSync(o._[2]);
    const a = new Snes({ wasm: o._[0], log: quiet, now: () => 1e12 }), b = new Snes({ wasm: o._[1], log: quiet, now: () => 1e12 });
    await a.compile(); await b.compile();
    if (!a.load(rom) || !b.load(rom)) throw new Error('the game did not load');
    const pads = schedule(o);
    let first = -1, differing = 0, last = -1;
    for (let f = 0; f < o.frames; f++) {
        a.setPad(0, pads[f]); b.setPad(0, pads[f]);
        a.run(); b.run();
        const x = a.frame(), y = b.frame();
        if (!x || !y) continue;
        let n = 0, top = -1, bottom = -1;
        if (x.w !== y.w || x.h !== y.h) n = -1;
        else {
            const u = new Uint32Array(x.px.buffer, x.px.byteOffset, x.w * x.h), v = new Uint32Array(y.px.buffer, y.px.byteOffset, y.w * y.h);
            for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) { n++; const row = (i / x.w) | 0; if (top < 0) top = row; bottom = row; }
        }
        if (n) {
            differing++; last = f;
            if (first < 0 || differing <= 3) {
                if (first < 0) first = f;
                console.log('frame ' + f + ': ' + (n < 0 ? 'sizes ' + x.w + 'x' + x.h + ' and ' + y.w + 'x' + y.h : n + ' pixels differ, rows ' + top + ' to ' + bottom + ' of ' + x.w + 'x' + x.h));
                fs.writeFileSync(path.join(out, 'a-' + f + '.png'), png(x.px, x.w, x.h));
                fs.writeFileSync(path.join(out, 'b-' + f + '.png'), png(y.px, y.w, y.h));
            }
        }
    }
    console.log(differing ? differing + ' of ' + o.frames + ' frames differ, the first ' + first + ', the last ' + last + '; pictures in ' + out : 'the same in all ' + o.frames + ' frames');
})().catch((e) => { console.error(e); process.exit(1); });
