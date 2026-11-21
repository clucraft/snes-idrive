'use strict';
/**
 * table.js - the bake-off's results as tables (Markdown), from .cache/bakeoff/results/<name>.jsonl (run.js).
 *
 *   node bakeoff/table.js [name]        default: matrix
 */
const fs = require('fs');
const path = require('path');
const { OUT } = require('./build');

const name = process.argv[2] || 'matrix';
const rows = fs.readFileSync(path.join(OUT, 'results', name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const builds = [], roms = [];
rows.forEach((r) => { if (builds.indexOf(r.build) < 0) builds.push(r.build); if (roms.indexOf(r.rom) < 0) roms.push(r.rom); });
const get = (b, rom) => rows.filter((r) => r.build === b && r.rom === rom)[0];
const f2 = (x) => (x == null ? '-' : x.toFixed(2));
const line = (cells) => '| ' + cells.join(' | ') + ' |';

console.log('### Milliseconds a frame: mean (99th percentile, worst)\n');
console.log(line(['game'].concat(builds)));
console.log(line(['---'].concat(builds.map(() => '---'))));
roms.forEach((rom) => console.log(line([rom.replace(/\.[^.]+$/, '')].concat(builds.map((b) => { const r = get(b, rom); return !r || r.error ? 'failed' : f2(r.meanMs) + ' (' + f2(r.p99Ms) + ', ' + f2(r.worstMs) + ')'; })))));

console.log('\n### Per build\n');
console.log(line(['build', '.wasm bytes', 'compile ms (min - max)', 'mean of means ms', 'heaviest game: mean ms', 'worst frame ms', 'memory MiB', 'process MB (max)', 'state bytes', 'state save ms', 'sound Hz', 'fps']));
console.log(line(new Array(12).fill('---')));
builds.forEach((b) => {
    const rs = rows.filter((r) => r.build === b && !r.error);
    if (!rs.length) { console.log(line([b, 'failed'])); return; }
    const comp = rs.map((r) => r.compileMs), means = rs.map((r) => r.meanMs);
    const heavy = rs.reduce((a, r) => (r.meanMs > a.meanMs ? r : a), rs[0]);
    console.log(line([b, rs[0].wasmBytes, Math.min.apply(null, comp) + ' - ' + Math.max.apply(null, comp), f2(means.reduce((a, x) => a + x, 0) / means.length),
        f2(heavy.meanMs) + ' (' + heavy.rom.replace(/\.[^.]+$/, '').slice(0, 24) + ')', f2(Math.max.apply(null, rs.map((r) => r.worstMs))),
        (rs[0].memEnd / 1048576).toFixed(0) + (rs.some((r) => r.memEnd !== r.memAtLoad) ? ' (grew)' : ''), Math.max.apply(null, rs.map((r) => r.rssMB)).toFixed(0),
        Math.max.apply(null, rs.map((r) => r.stateBytes || 0)), f2(Math.max.apply(null, rs.map((r) => r.stateMs || 0))), rs[0].sampleRate, rs[0].fps]));
});
const sizes = {};
rows.forEach((r) => { if (r.sizes) Object.keys(r.sizes).forEach((s) => { if (s !== '256x224') (sizes[r.rom] = sizes[r.rom] || {})[r.build] = Object.keys(r.sizes).join(' and '); }); });
if (Object.keys(sizes).length) {
    console.log('\n### Pictures that are not 256 x 224\n');
    Object.keys(sizes).forEach((rom) => console.log('- ' + rom + ': ' + builds.map((b) => b + ' ' + (sizes[rom][b] || '256x224')).join('; ')));
}
