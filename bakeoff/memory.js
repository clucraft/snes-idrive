'use strict';
/**
 * memory.js - how far each core's WebAssembly memory reaches, to give it all of that from the start.
 *
 *   node bakeoff/memory.js <core>...        (needs the builds made with: node bakeoff/build.js <core> -O2 --grow)
 *
 * Runs a 6 MB game (the biggest cartridges made; here a small test ROM repeated to that size, which plays as
 * the small one does), then a save state and a load of it, under Node 8, with a build whose memory starts
 * small and grows. Where the memory ends is what `mem` in bakeoff/cores.js has to cover.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OUT, ROOT } = require('./build');
const { node8 } = require('./verify');

const small = path.join(ROOT, 'roms', 'free', 'fixed', 'PPU_Mode7_StarWars.sfc');
const bigDir = path.join(ROOT, 'roms', 'free', 'big'), big = path.join(bigDir, 'Repeated6MB.sfc');
if (!fs.existsSync(big)) {
    const b = fs.readFileSync(small), out = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < out.length; i += b.length) b.copy(out, i);
    for (let i = 0x7fd7; i < out.length; i += 0x8000) out[i] = 13;          // the header's ROM size, in every copy of it
    if (!fs.existsSync(bigDir)) fs.mkdirSync(bigDir);
    fs.writeFileSync(big, out);
}
const MB = 1048576;
process.argv.slice(2).forEach((core) => {
    const wasm = path.join(OUT, core + '-O2-grow.wasm');
    const rows = [small, big].map((rom) => {
        const r = spawnSync(node8(), [path.join(__dirname, 'bench.js'), wasm, rom, '--frames', '600', '--state', '--json'], { maxBuffer: 1 << 26 });
        return JSON.parse(r.stdout.toString());
    });
    const end = rows[1].memEnd;
    console.log(core + ': a small game ' + (rows[0].memEnd / MB).toFixed(2) + ' MiB, a 6 MB game ' + (end / MB).toFixed(2) + ' MiB (at load ' + (rows[1].memAtLoad / MB).toFixed(2) + '); a save state ' + rows[1].stateBytes + ' bytes' +
        (rows[1].error ? '  ERROR ' + rows[1].error : '') + '  -> mem 0x' + (Math.ceil((end + 2 * MB) / MB) * MB).toString(16));
});
