'use strict';
/**
 * cc65's assembler and linker (ca65, ld65) for games/build.js, on a computer that has none:
 *
 *   node tools/cc65.js          builds them from cc65's source into .cache/cc65/bin/
 *
 * cc65 (https://cc65.github.io, zlib licence) is in every Linux distribution (`apt install cc65`) and in
 * Homebrew; games/build.js takes ca65 and ld65 from the PATH when they are there, and nothing here is needed.
 * This is for the rest (Windows): cc65's release V2.19 from its repository, the two programs built with the
 * C compiler this project already has, zig (as core/build.js finds it). Nothing is installed outside .cache/.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '.cache', 'cc65-src'), BIN = path.join(ROOT, '.cache', 'cc65', 'bin');
const WIN = process.platform === 'win32', EXE = WIN ? '.exe' : '';
const TAG = 'V2.19';

/** [ca65, ld65] as they can be run, or null: from the PATH, or the ones built here */
function find() {
    const on = (name) => { const r = spawnSync(name, ['--version']); return !r.error && r.status === 0; };
    if (on('ca65') && on('ld65')) return ['ca65', 'ld65'];
    const own = ['ca65', 'ld65'].map((n) => path.join(BIN, n + EXE));
    return own.every((f) => fs.existsSync(f)) ? own : null;
}

function zig() {
    if (process.env.ZIG) return process.env.ZIG.split(' ');
    const local = path.join(ROOT, '.cache', 'py', 'ziglang', WIN ? 'zig.exe' : 'zig');
    return fs.existsSync(local) ? [local] : [WIN ? 'python' : 'python3', '-m', 'ziglang'];
}
function run(cmd, args, opts) {
    const r = spawnSync(cmd[0], cmd.slice(1).concat(args), Object.assign({ stdio: 'inherit' }, opts || {}));
    if (r.status !== 0) throw new Error(path.basename(cmd[0]) + ' failed (' + (r.status === null ? r.signal || r.error : r.status) + ')');
}

function build() {
    if (!fs.existsSync(path.join(SRC, 'src', 'ca65'))) {
        run(['git'], ['clone', '-q', '--depth', '1', '--branch', TAG, 'https://github.com/cc65/cc65.git', SRC]);
    }
    BIN.split(path.sep).reduce((d, p) => { const n = d ? d + path.sep + p : p; if (n && !fs.existsSync(n)) fs.mkdirSync(n); return n; }, '');
    const c = (dir) => fs.readdirSync(path.join(SRC, 'src', dir)).filter((f) => /\.c$/.test(f)).map((f) => path.join(SRC, 'src', dir, f));
    ['ca65', 'ld65'].forEach((prog) => {
        const out = path.join(BIN, prog + EXE), rsp = path.join(BIN, prog + '.rsp');
        const args = ['-O2', '-Wno-everything', '-I' + path.join(SRC, 'src', 'common'), '-o', out].concat(c(prog), c('common'));
        fs.writeFileSync(rsp, args.map((a) => '"' + a.replace(/\\/g, '/') + '"').join('\n'));
        run(zig(), ['cc', '@' + rsp]);
        fs.unlinkSync(rsp);
        console.log('cc65: ' + path.relative(ROOT, out));
    });
}

module.exports = { find, build };

if (require.main === module) {
    try { build(); const f = find(); console.log('cc65: ' + (f ? f.join(', ') : 'not built')); } catch (e) { console.error('cc65: ' + e.message); process.exit(1); }
}
