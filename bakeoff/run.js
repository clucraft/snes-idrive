'use strict';
/**
 * run.js - the bake-off's measurements: every build named, on every game named, each in a Node 8 process of
 * its own (bakeoff/bench.js), one at a time so they do not take each other's processor.
 *
 *   node bakeoff/run.js --builds snes9x2005-Os,snes9x2010-O2 [--frames 3000] [--mash] [--state] [--out name]
 *        [--var core:key=value]... <game.sfc | folder>...
 *
 * Writes .cache/bakeoff/results/<name>.jsonl, a line per run, and prints a table: milliseconds a frame
 * (mean / 99th percentile / worst) per game and build.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OUT } = require('./build');
const { node8 } = require('./verify');

function games(list) {
    const out = [];
    list.forEach((p) => {
        if (fs.statSync(p).isDirectory()) fs.readdirSync(p).sort().forEach((f) => { if (/\.(sfc|smc)$/i.test(f)) out.push(path.join(p, f)); });
        else out.push(p);
    });
    return out;
}

function main(a) {
    let builds = [], frames = 3000, out = 'run', extra = [];
    const vars = {}, rest = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--builds') builds = a[++i].split(',');
        else if (a[i] === '--frames') frames = +a[++i];
        else if (a[i] === '--out') out = a[++i];
        else if (a[i] === '--mash' || a[i] === '--state') extra.push(a[i]);
        else if (a[i] === '--warm') extra.push(a[i], a[++i]);
        else if (a[i] === '--var') { const m = /^([^:]+):(.*)$/.exec(a[++i]); (vars[m[1]] = vars[m[1]] || []).push(m[2]); }
        else rest.push(a[i]);
    }
    const roms = games(rest), dir = path.join(OUT, 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const file = path.join(dir, out + '.jsonl');
    fs.writeFileSync(file, '');
    const rows = [];
    roms.forEach((rom) => {
        const row = { rom: path.basename(rom).replace(/\.[^.]+$/, '') };
        builds.forEach((b) => {
            const core = b.replace(/-O.*$/, ''), va = [];
            (vars[core] || []).concat(vars['*'] || []).forEach((v) => va.push('--var', v));
            const r = spawnSync(node8(), [path.join(__dirname, 'bench.js'), path.join(OUT, b + '.wasm'), rom, '--frames', String(frames), '--json'].concat(extra, va), { maxBuffer: 1 << 26 });
            let j;
            try { j = JSON.parse(r.stdout.toString()); } catch (e) { j = { error: 'no result: ' + String(r.stderr).slice(0, 200) }; }
            j.build = b;
            fs.appendFileSync(file, JSON.stringify(j) + '\n');
            row[b] = j.error ? 'FAILED' : j.meanMs.toFixed(2) + ' / ' + j.p99Ms.toFixed(2) + ' / ' + j.worstMs.toFixed(2);
            if (j.error) console.error(b + ' ' + row.rom + ': ' + j.error);
        });
        rows.push(row);
        console.log([(row.rom + '                                        ').slice(0, 40)].concat(builds.map((b) => (row[b] + '                        ').slice(0, 24))).join(' '));
    });
    console.log('(ms a frame: mean / 99th percentile / worst; ' + frames + ' frames; ' + builds.join(', ') + ') -> ' + path.relative(process.cwd(), file));
}

if (require.main === module) main(process.argv.slice(2));
