'use strict';
/**
 * cputests.js - krom's CPU and SPC700 test ROMs on every core: each test ends on a screen of PASS lines, or
 * stops at its first FAIL. The cores' last pictures are compared with a reference core's (current Snes9x,
 * which passes them): the same picture is the same verdict. For the ones that differ a PNG is written, to read.
 *
 *   node bakeoff/cputests.js <folder of the test ROMs> <reference build> <build>...     (builds: names in .cache/bakeoff)
 */
const fs = require('fs');
const path = require('path');
const { Snes } = require('../app/snes-core');
const { png } = require('./bench');
const { OUT } = require('./build');

const dir = process.argv[2], builds = process.argv.slice(3);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const shots = path.join(OUT, '..', 'shots', 'cputests');
if (!fs.existsSync(path.dirname(shots))) fs.mkdirSync(path.dirname(shots));
if (!fs.existsSync(shots)) fs.mkdirSync(shots);
(async () => {
    const cores = [];
    for (let i = 0; i < builds.length; i++) { const s = new Snes({ wasm: path.join(OUT, builds[i] + '.wasm'), log: quiet, now: () => 1e12 }); await s.compile(); cores.push(s); }
    const roms = fs.readdirSync(dir).filter((f) => /^CPUTest_/.test(f)).sort();
    const differ = builds.map(() => []);
    roms.forEach((f) => {
        const rom = fs.readFileSync(path.join(dir, f));
        const pics = cores.map((s) => {
            if (!s.load(rom)) return null;
            for (let i = 0; i < 900; i++) s.run();
            const fr = s.frame();
            if (!fr) return null;
            // what is written where, whatever the core makes of the colours: each pixel as the background's colour (the
            // picture's first pixel) or not
            const ink = Buffer.alloc(fr.w * fr.h);
            for (let k = 0; k < ink.length; k++) ink[k] = fr.px[k * 4] !== fr.px[0] || fr.px[k * 4 + 1] !== fr.px[1] || fr.px[k * 4 + 2] !== fr.px[2] ? 1 : 0;
            return { w: fr.w, h: fr.h, px: Buffer.from(fr.px), ink };
        });
        pics.forEach((p, i) => {
            if (i === 0) return;
            if (!p || !pics[0] || !p.ink.equals(pics[0].ink)) {
                differ[i].push(f.replace(/^CPUTest_|\.sfc$/g, ''));
                if (p) fs.writeFileSync(path.join(shots, builds[i] + '-' + f.replace(/\.sfc$/, '.png')), png(p.px, p.w, p.h));
            }
        });
        if (pics[0]) fs.writeFileSync(path.join(shots, builds[0] + '-' + f.replace(/\.sfc$/, '.png')), png(pics[0].px, pics[0].w, pics[0].h));
    });
    console.log(roms.length + ' tests; the reference is ' + builds[0]);
    builds.forEach((b, i) => { if (i) console.log(b + ': ' + (roms.length - differ[i].length) + ' end as the reference does' + (differ[i].length ? '; not: ' + differ[i].join(', ') : '')); });
    console.log('pictures in ' + shots);
})().catch((e) => { console.error(e); process.exit(1); });
