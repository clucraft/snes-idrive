'use strict';
/**
 * nes-baseline.js - what the NES app's own log line measures, on this computer, to set beside the same line
 * read off a car.
 *
 * The NES app (clucraft/nes-idrive) writes into its log, every ten seconds a game runs:
 *     game 60.0 fps, 0.85 ms a frame in the emulator
 * and once at its start:
 *     nes: emulator compiled in 2100 ms
 * This measures the same two things here, with that app's nes.wasm and its two games, under whatever Node
 * runs it (Node 8 for the comparison: tools/node8.js):
 *
 *   node bakeoff/nes-baseline.js <path to the nes-idrive checkout> [game.nes]...
 *
 * car's ms a frame / this computer's = how many times slower the head unit runs an emulator of this kind.
 */
const fs = require('fs');
const path = require('path');

const repo = process.argv[2];
if (!repo) { console.error('usage: node bakeoff/nes-baseline.js <nes-idrive checkout> [game.nes]...'); process.exit(2); }
const { Nes } = require(path.join(repo, 'app', 'nes-core'));
const games = process.argv.length > 3 ? process.argv.slice(3) : ['Snake.nes', 'Pad_Test.nes'].map((g) => path.join(repo, 'app', 'games', g));
const ms = (t) => { const d = process.hrtime(t); return d[0] * 1000 + d[1] / 1e6; };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
    console.log('node ' + process.version + ', nes.wasm ' + fs.statSync(path.join(repo, 'app', 'nes.wasm')).size + ' bytes');
    for (let k = 0; k < 3; k++) {
        const t = process.hrtime();
        await WebAssembly.compile(fs.readFileSync(path.join(repo, 'app', 'nes.wasm')));
        console.log('compiled in ' + ms(t).toFixed(0) + ' ms');
    }
    const nes = new Nes({ wasm: path.join(repo, 'app', 'nes.wasm'), log: quiet });
    await nes.compile();
    games.forEach((g) => {
        if (!nes.load(fs.readFileSync(g))) { console.log(path.basename(g) + ': did not load'); return; }
        for (let i = 0; i < 300; i++) nes.run();
        // as the app's loop: 600 frames (ten seconds), pad in, a frame, the sound taken
        const means = [];
        for (let r = 0; r < 5; r++) {
            const t = process.hrtime();
            for (let i = 0; i < 600; i++) { nes.setPad(0, 0); nes.run(); nes.audio(); }
            means.push(ms(t) / 600);
        }
        console.log(path.basename(g) + ': ' + means.map((m) => m.toFixed(3)).join(', ') + ' ms a frame (five times 600 frames)');
    });
})().catch((e) => { console.error(e); process.exit(1); });
