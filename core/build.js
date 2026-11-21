'use strict';
/**
 * build.js - snes9x2005 (vendor/snes9x2005, unchanged) + mgu_libretro.c -> the app's emulator:
 *
 *   node core/build.js          (npm run build:core)
 *
 *     app/snes.wasm         the core with its own sound chip emulation (Snes9x 1.43's)
 *     app/snes-plus.wasm    the same with blargg's (the core's USE_BLARGG_APU): truer sound, more time a frame
 *
 * The recipe is the NES project's and the kit's (for its Doom): zig 0.13 as the C compiler for wasm32-wasi
 * with the first version of WebAssembly only (-mcpu=mvp: the head unit's Node 8 knows nothing newer), then
 * binaryen 119's wasm-opt, which lowers sign extension and splits 64-bit arguments for JavaScript
 * (--legalize-js-interface). Besides:
 *
 *   - 24 MiB of memory from the start, a 2 MiB stack. Node 8 grows a WebAssembly memory by copying it, and the
 *     copies it leaves behind count against the app's memory limit. The core reaches 21 MiB with a 6 MB game
 *     and a save state (bakeoff/README.md); the rest is for what a special chip's game may still ask for.
 *   - -Os. For this core -O2 is no faster under Node 8 (bakeoff/README.md), and bigger.
 *   - The file list is the core's Makefile.common with LOAD_FROM_MEMORY=1, as its own Makefile has it.
 *
 * Needs: zig 0.13 (`pip install ziglang==0.13.0`, or into this checkout: `pip install --target .cache/py
 * ziglang==0.13.0`) and binaryen 119's wasm-opt (`npm install binaryen@119`, here in .cache/npm). Override with
 * ZIG="zig" / WASM_OPT=/path/to/wasm-opt. Two builds give the same bytes; `node core/build.js --check` builds
 * into a temporary folder and says whether app/'s files are what this source gives.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'vendor', 'snes9x2005');
const WIN = process.platform === 'win32';
const INITIAL_MEMORY = '0x1800000';                 // (in hex: zig 0.13 reads the number after --initial-memory= as hexadecimal)
const STACK_SIZE = 2097152;
const OPT = process.env.OPT || '-Os';

const COMMON = ['c4.c', 'c4emu.c', 'cheats2.c', 'cheats.c', 'clip.c', 'cpu.c', 'cpuexec.c', 'cpuops.c', 'data.c', 'dma.c', 'dsp1.c',
    'fxemu.c', 'fxinst.c', 'gfx.c', 'getset.c', 'globals.c', 'memmap.c', 'obc1.c', 'ppu.c', 'sa1.c', 'sa1cpu.c', 'sdd1.c',
    'sdd1emu.c', 'seta010.c', 'seta011.c', 'seta018.c', 'seta.c', 'spc7110.c', 'spc7110dec.c', 'srtc.c', 'tile.c'];
const VARIANTS = [
    { out: 'snes.wasm', srcs: ['apu.c', 'soundux.c', 'spc700.c'], defs: [] },
    { out: 'snes-plus.wasm', srcs: ['apu_blargg.c'], defs: ['-DUSE_BLARGG_APU'] },
];

function zig() {
    if (process.env.ZIG) return process.env.ZIG.split(' ');
    const local = path.join(ROOT, '.cache', 'py', 'ziglang', WIN ? 'zig.exe' : 'zig');
    return fs.existsSync(local) ? [local] : [WIN ? 'python' : 'python3', '-m', 'ziglang'];
}
function wasmOpt() {
    if (process.env.WASM_OPT) return [process.env.WASM_OPT];
    const local = path.join(ROOT, '.cache', 'npm', 'node_modules', 'binaryen', 'bin', 'wasm-opt');
    return fs.existsSync(local) ? [process.execPath, local] : ['wasm-opt'];
}
function run(cmd, args) {
    const r = spawnSync(cmd[0], cmd.slice(1).concat(args), { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(path.basename(cmd[0]) + ' failed (' + (r.status === null ? r.signal || r.error : r.status) + ')');
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function build(v, outDir, tmp) {
    const raw = path.join(tmp, v.out.replace('.wasm', '-raw.wasm')), out = path.join(outDir, v.out);
    const srcs = COMMON.concat(v.srcs).map((f) => path.join(CORE, 'source', f)).concat([path.join(CORE, 'libretro.c'), path.join(__dirname, 'mgu_libretro.c')]);
    // (the frontend takes libretro.h from core/: the core's own copy is the same API, an older text)
    const args = ['cc', '-target', 'wasm32-wasi', '-mcpu=mvp', '-mexec-model=reactor', OPT,
        '-D__LIBRETRO__', '-DLOAD_FROM_MEMORY', '-DLAGFIX', '-DNDEBUG', '-fno-strict-overflow', '-DPATH_MAX=1024', '-D_DEFAULT_SOURCE',
        '-D_WASI_EMULATED_SIGNAL', '-D_WASI_EMULATED_PROCESS_CLOCKS', '-Wno-everything']
        .concat(v.defs, ['-I' + path.join(CORE, 'source'), '-I' + CORE, '-I' + path.join(CORE, 'libretro-common', 'include'),
            '-Wl,--initial-memory=' + INITIAL_MEMORY, '-Wl,-z,stack-size=' + STACK_SIZE, '-o', raw], srcs,
        ['-lwasi-emulated-signal', '-lwasi-emulated-process-clocks']);
    const rsp = path.join(tmp, v.out + '.rsp');
    fs.writeFileSync(rsp, args.slice(1).map((a) => '"' + a.replace(/\\/g, '/').replace(/"/g, '\\"') + '"').join('\n'));
    run(zig(), ['cc', '@' + rsp]);
    run(wasmOpt(), [raw, '--enable-sign-ext', '--enable-mutable-globals', '--legalize-js-interface', '--signext-lowering', '--strip-debug', '--strip-producers', OPT, '-o', out]);
    return out;
}

function main(argv) {
    if (!fs.existsSync(path.join(CORE, 'source', 'cpu.c'))) throw new Error('vendor/snes9x2005 is empty - run: git submodule update --init');
    const check = argv.indexOf('--check') >= 0;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snes-core-'));
    const outDir = check ? tmp : path.join(ROOT, 'app');
    let differ = 0;
    try {
        VARIANTS.forEach((v) => {
            const out = build(v, outDir, tmp), own = path.join(ROOT, 'app', v.out);
            if (check) {
                const same = fs.existsSync(own) && sha(own) === sha(out);
                if (!same) differ++;
                console.log('build: app/' + v.out + (same ? ' is what this source gives' : ' is NOT what this source gives') + ' (SHA-256 ' + sha(out).slice(0, 16) + '...)');
            } else console.log('build: app/' + v.out + ', ' + fs.statSync(out).size + ' bytes, SHA-256 ' + sha(out));
        });
    } finally {
        fs.readdirSync(tmp).forEach((f) => { try { fs.unlinkSync(path.join(tmp, f)); } catch (e) { /* left */ } });
        try { fs.rmdirSync(tmp); } catch (e) { /* left */ }
    }
    return differ;
}

if (require.main === module) {
    try { process.exit(main(process.argv.slice(2)) ? 1 : 0); } catch (e) { console.error('build: ' + e.message); process.exit(1); }
}
