'use strict';
/**
 * native-all.js - every core's native build on the same games: who takes which game, and how the cores
 * compare in speed before WebAssembly comes into it (the native numbers include hashing every picture).
 *
 *   node bakeoff/native-all.js [--frames 1500] [--cores a,b] <game.sfc | folder>...
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OUT } = require('./build');
const cores = require('./cores');

const a = process.argv.slice(2);
let frames = 1500, names = Object.keys(cores);
const rest = [];
for (let i = 0; i < a.length; i++) {
    if (a[i] === '--frames') frames = +a[++i];
    else if (a[i] === '--cores') names = a[++i].split(',');
    else rest.push(a[i]);
}
// (Supafaust wants every option it reads answered; "st" counts in the measuring variant only: cores.js)
const SF = ['supafaust_renderer=st', 'supafaust_thread_affinity_emu=0x0', 'supafaust_slstart=0', 'supafaust_slend=223', 'supafaust_slstartp=0', 'supafaust_slendp=238'];
const VARS = { supafaust: SF, supafaust_st: SF };
const roms = [];
rest.forEach((p) => {
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).sort().forEach((f) => { if (/\.(sfc|smc)$/i.test(f)) roms.push(path.join(p, f)); });
    else roms.push(p);
});
const exe = (n) => path.join(OUT, n + '-native' + (process.platform === 'win32' ? '.exe' : ''));
names = names.filter((n) => fs.existsSync(exe(n)));
console.log(['game                                    '].concat(names.map((n) => (n + '               ').slice(0, 16))).join(' '));
roms.forEach((rom) => {
    const cells = names.map((n) => {
        const r = spawnSync(exe(n), [rom, String(frames)].concat(VARS[n] || []), { maxBuffer: 1 << 26 });
        const out = String(r.stdout);
        const m = /native ms\/frame ([\d.]+)/.exec(out), last = out.split(/\r?\n/).filter((l) => /^\d+ /.test(l)).pop();
        if (r.status !== 0 || !m) return /did not take/.test(out) ? 'refused' : 'FAILED ' + (r.status === null ? r.signal : r.status);
        return m[1] + ' ' + (last ? last.split(' ')[1] : '');
    });
    console.log([(path.basename(rom).replace(/\.[^.]+$/, '') + '                                        ').slice(0, 40)].concat(cells.map((c) => (c + '                ').slice(0, 16))).join(' '));
});
