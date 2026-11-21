'use strict';
/**
 * build.js - one core of the bake-off (bakeoff/cores.js) with core/mgu_libretro.c, as the head unit would get it
 * and as this computer runs it:
 *
 *   node bakeoff/build.js <core> [-Os|-O2|-O3] [--grow] [--mem=0x...]    ->  .cache/bakeoff/<core><-Ox>.wasm
 *   node bakeoff/build.js <core> --native                                 ->  .cache/bakeoff/<core>-native[.exe]
 *   node bakeoff/build.js --fetch                                         the cores' sources, at their commits
 *
 * The recipe is the NES project's (core/build.sh there): zig 0.13 as the compiler for wasm32-wasi with the
 * first version of WebAssembly only (-mcpu=mvp: the head unit's Node 8 knows nothing newer), then binaryen 119's
 * wasm-opt, which lowers sign extension and splits 64-bit arguments for JavaScript.
 *
 * --grow builds without a fixed memory size, to measure how far a core's memory reaches (bakeoff/bench.js
 * reports it). Otherwise the memory is the core's `mem` in cores.js, all of it from the start: Node 8 grows a
 * WebAssembly memory by copying it.
 *
 * The native build is the same sources for this computer, with bakeoff/native_main.c: what the .wasm's
 * pictures are checked against (bakeoff/verify.js).
 *
 * Tools: ZIG (default: .cache/py/ziglang/zig, from `pip install --target .cache/py ziglang==0.13.0`, or
 * `python3 -m ziglang`) and WASM_OPT (default: .cache/npm/node_modules/binaryen/bin/wasm-opt, from
 * `npm install binaryen@119`).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cores = require('./cores');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '.cache', 'cores');
const OUT = path.join(ROOT, '.cache', 'bakeoff');
// NATIVE_TARGET=x86_64-linux-gnu builds the native program for Linux from Windows (to run it in WSL)
const NATIVE_TARGET = process.env.NATIVE_TARGET || '';
const WIN = process.platform === 'win32' && !/linux/.test(NATIVE_TARGET);
const STACK = 2097152;

function zig() {
    if (process.env.ZIG) return process.env.ZIG.split(' ');
    const local = path.join(ROOT, '.cache', 'py', 'ziglang', process.platform === 'win32' ? 'zig.exe' : 'zig');
    return fs.existsSync(local) ? [local] : [WIN ? 'python' : 'python3', '-m', 'ziglang'];
}
function zigVersion() {
    const z = zig(), r = spawnSync(z[0], z.slice(1).concat(['version']));
    return String(r.stdout || '').trim();
}
function wasmOpt() {
    if (process.env.WASM_OPT) return [process.env.WASM_OPT];
    return [process.execPath, path.join(ROOT, '.cache', 'npm', 'node_modules', 'binaryen', 'bin', 'wasm-opt')];
}
function run(cmd, args, opts) {
    const r = spawnSync(cmd[0], cmd.slice(1).concat(args), Object.assign({ stdio: 'inherit' }, opts || {}));
    if (r.status !== 0) throw new Error(path.basename(cmd[0]) + ' failed (' + (r.status === null ? r.signal || r.error : r.status) + ')');
}

function fetch() {
    fs.mkdirSync(SRC, { recursive: true });
    const seen = {};
    Object.keys(cores).forEach((k) => {
        const c = cores[k], dir = path.join(SRC, c.dir);
        if (seen[c.dir]) return;
        seen[c.dir] = true;
        if (!fs.existsSync(path.join(dir, '.git'))) {
            run(['git'], ['init', '-q', dir]);
            run(['git'], ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/' + c.repo + '.git']);
        }
        const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
        if (head !== c.commit) {
            run(['git'], ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', c.commit]);
            run(['git'], ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
        }
        console.log('build: ' + c.dir + ' at ' + c.commit.slice(0, 7));
    });
}

function sources(c, native, name) {
    const list = c.srcs.slice();
    if (c.threads) list.push(native && WIN ? c.threads.win : c.threads.posix);
    return list.map((f) => {
        const src = path.join(SRC, c.dir, f);
        if (!c.patch || !c.patch[f]) return src;
        // a measuring variant only: this file with a change, as a copy beside the builds (the core's folder stays as fetched)
        let text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');   // (a Windows checkout may have CRLF)
        c.patch[f].forEach((p) => { if (text.indexOf(p[0]) < 0) throw new Error(f + ': "' + p[0] + '" is not in it'); text = text.split(p[0]).join(p[1]); });
        const copy = path.join(OUT, name + '-patched-' + path.basename(f));
        fs.writeFileSync(copy, text);
        return copy;
    });
}

function build(name, o) {
    const c = cores[name];
    if (!c) throw new Error('no core "' + name + '": ' + Object.keys(cores).join(', '));
    if (!fs.existsSync(path.join(SRC, c.dir))) throw new Error('.cache/cores/' + c.dir + ' is not there: node bakeoff/build.js --fetch');
    fs.mkdirSync(OUT, { recursive: true });
    const inc = c.inc.map((d) => '-I' + path.join(SRC, c.dir, d));
    const common = ['-D__LIBRETRO__', '-Wno-everything'].concat(c.defs, o.defs || [], inc);
    const t = Date.now();
    // the frontend (and the native runner) as objects of their own: C, whatever the core's flags are for
    const object = (src, flags, tag) => {
        const obj = path.join(OUT, tag + '-' + path.basename(src).replace(/.c$/, '.o'));
        run(zig(), ['cc', '-c'].concat(flags, ['-Wno-everything', '-I' + path.join(ROOT, 'core'), '-o', obj, src]));
        return obj;
    };
    if (o.native) {
        const out = path.join(OUT, name + '-native' + (WIN ? '.exe' : ''));
        const tgt = NATIVE_TARGET ? ['-target', NATIVE_TARGET] : [];
        const front = object(path.join(ROOT, 'core', 'mgu_libretro.c'), tgt.concat(['-O2']), name + '-native');
        const main = object(path.join(__dirname, 'native_main.c'), tgt.concat(['-O2']), name + '-native');
        const args = ['cc', '-O2'].concat(tgt, common, c.nativeDefs || [], c.cxxflags || [], ['-o', out], sources(c, true, name), [front, main], c.cxx ? ['-lc++'] : []);
        const rsp = path.join(OUT, name + '-native.rsp');
        fs.writeFileSync(rsp, args.slice(1).map((a) => '"' + a.replace(/\\/g, '/').replace(/"/g, '\\"') + '"').join('\n'));
        run(zig(), ['cc', '@' + rsp]);
        console.log('build: ' + path.relative(ROOT, out) + ' in ' + ((Date.now() - t) / 1000).toFixed(1) + ' s');
        return out;
    }
    const opt = o.opt || '-Os';
    const tag = name + opt + (o.grow ? '-grow' : '') + (o.tag || '');
    const raw = path.join(OUT, tag + '-raw.wasm'), out = path.join(OUT, tag + '.wasm');
    const mem = o.mem || c.mem;
    const target = ['-target', 'wasm32-wasi', '-mcpu=mvp'];
    const front = object(path.join(ROOT, 'core', 'mgu_libretro.c'), target.concat([opt]), tag);
    // the parts of a Unix C library that WASI leaves out and wasi-libc stands in for (EMULATE="signal mman" picks:
    // zig 0.14.1 cannot build its process-clocks)
    const emu = (process.env.EMULATE || 'signal process-clocks mman getpid').split(' ').filter(Boolean);
    const args = ['cc'].concat(target, ['-mexec-model=reactor', opt, '-DPATH_MAX=1024', '-D_DEFAULT_SOURCE'],
        emu.map((e) => '-D_WASI_EMULATED_' + e.toUpperCase().replace('-', '_')))
        .concat(c.cxx ? ['-fno-exceptions'] : [], c.cxxflags || [], c.wasmDefs || [], common,
            // (zig 0.13 reads this number as hexadecimal, with or without the 0x; zig 0.14 as decimal, and refuses the 0x)
            o.grow || !mem ? [] : ['-Wl,--initial-memory=' + (/^0\.13\./.test(zigVersion()) ? mem : String(parseInt(mem, 16)))],
            ['-Wl,-z,stack-size=' + STACK, '-o', raw], sources(c, false, name), [front],
            emu.map((e) => '-lwasi-emulated-' + e), c.cxx ? ['-lc++'] : []);
    const rsp = path.join(OUT, tag + '.rsp');
    fs.writeFileSync(rsp, args.slice(1).map((a) => '"' + a.replace(/\\/g, '/').replace(/"/g, '\\"') + '"').join('\n'));
    run(zig(), ['cc', '@' + rsp]);
    const t2 = Date.now();
    run(wasmOpt(), [raw, '--enable-sign-ext', '--enable-mutable-globals', '--legalize-js-interface', '--signext-lowering', '--strip-debug', '--strip-producers', opt, '-o', out]);
    fs.unlinkSync(raw);
    console.log('build: ' + path.relative(ROOT, out) + ', ' + fs.statSync(out).size + ' bytes (zig ' + ((t2 - t) / 1000).toFixed(1) + ' s, wasm-opt ' + ((Date.now() - t2) / 1000).toFixed(1) + ' s)');
    return out;
}

module.exports = { build, fetch, OUT, ROOT };

if (require.main === module) {
    const a = process.argv.slice(2);
    try {
        if (a.indexOf('--fetch') >= 0) fetch();
        const names = a.filter((x) => x[0] !== '-');
        const opt = a.filter((x) => /^-O/.test(x))[0];
        const mem = (a.filter((x) => /^--mem=/.test(x))[0] || '').slice(6) || undefined;
        names.forEach((n) => build(n, { native: a.indexOf('--native') >= 0, grow: a.indexOf('--grow') >= 0, opt, mem }));
    } catch (e) { console.error('build: ' + e.message); process.exit(1); }
}
