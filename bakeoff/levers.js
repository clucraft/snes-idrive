'use strict';
/**
 * levers.js - what the app's two levers are worth, with the app's own cores (app/snes.wasm, app/snes-plus.wasm):
 * a frame that is run and not drawn against one that is drawn, and a high-resolution picture shrunk to the
 * console's size against one handed over as it is.
 *
 *   node bakeoff/levers.js <game.sfc>...          (Node 8 for the numbers that count: tools/node8.js)
 */
const fs = require('fs');
const path = require('path');
const { Snes } = require('../app/snes-core');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ms = (t) => { const d = process.hrtime(t); return d[0] * 1000 + d[1] / 1e6; };
const mean = (snes, n, draw) => { const t = process.hrtime(); for (let i = 0; i < n; i++) snes.run(draw); return ms(t) / n; };

(async () => {
    console.log('node ' + process.version + '; ms a frame: drawn / every second one drawn / none drawn; then the picture, as it is and shrunk');
    for (const file of ['snes.wasm', 'snes-plus.wasm']) {
        const snes = new Snes({ wasm: path.join(__dirname, '..', 'app', file), log: quiet, now: () => 1e12 });
        await snes.compile();
        process.argv.slice(2).forEach((rom) => {
            if (!snes.load(fs.readFileSync(rom))) { console.log(file + ' ' + path.basename(rom) + ': did not load'); return; }
            snes.setShrink(false);
            mean(snes, 300, true);
            const all = mean(snes, 1500, true);
            const t = process.hrtime();
            for (let i = 0; i < 1500; i++) snes.run(!(i & 1));
            const halfMs = ms(t) / 1500;
            const none = mean(snes, 1500, false);
            snes.run(true);
            const big = snes.frame();
            const asIs = big.w + 'x' + big.h;
            snes.setShrink(true);
            const shrunkMs = mean(snes, 600, true), f = snes.frame();
            console.log((file + '            ').slice(0, 15) + (path.basename(rom).replace(/\.[^.]+$/, '') + '                                  ').slice(0, 34) +
                all.toFixed(2) + ' / ' + halfMs.toFixed(2) + ' / ' + none.toFixed(2) + '   ' + asIs + ' -> ' + f.w + 'x' + f.h + (asIs !== f.w + 'x' + f.h ? ' at ' + shrunkMs.toFixed(2) + ' ms' : ''));
        });
    }
})().catch((e) => { console.error(e); process.exit(1); });
