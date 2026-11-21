'use strict';
/**
 * snes-core.js - runs the SNES emulator inside the app: a libretro core compiled to WebAssembly
 * (snes.wasm; core/ has its build, and NOTICE in this folder says which core it is and under what licence).
 *
 *   const snes = new Snes({ wasm, log });
 *   snes.compile().then(() => {            // once; compiled off the main thread
 *       snes.load(romBytes);               // an .sfc or .smc file
 *       snes.setPad(0, BTN.A | BTN.RIGHT);
 *       if (snes.run()) { const f = snes.frame(); ... f.px (RGBA), f.w, f.h }
 *   });
 *
 * The core is a libretro core; core/mgu_libretro.c is its frontend and exports the
 * few calls used here. Node 8 has no WASI, and the core needs no files (the ROM, save states and
 * battery memory go through buffers), so the C library's system calls answer "not there".
 * A crash inside the core (a trap) ends that instance only: the next load() makes a new one.
 */
const fs = require('fs');

/* the joypad: masks of RETRO_DEVICE_ID_JOYPAD_* bits, which are an SNES pad's twelve buttons */
const BTN = { B: 1 << 0, Y: 1 << 1, SELECT: 1 << 2, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7, A: 1 << 8, X: 1 << 9, L: 1 << 10, R: 1 << 11 };
const E = { OK: 0, BADF: 8, NOENT: 44, NOSYS: 52, SPIPE: 70 };
const LEVELS = ['debug', 'info', 'warn', 'error'];

const MAX_ROM = 8 * 1024 * 1024;                    // the biggest game taken (the biggest cartridges made are 6 MB)
const printable = (c) => (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xdf);   // ASCII, and the katakana of JIS X 0201

/**
 * What an .sfc / .smc file says about itself, or null when it is no SNES game.
 *
 * An SNES ROM has no signature at its start. Its header sits inside it, at 0x7FC0 (LoROM), 0xFFC0 (HiROM) or
 * 0x40FFC0 (the biggest games, ExHiROM), and a copier may have put 512 bytes of its own in front of all of it
 * (the file is then 512 over a multiple of 1024). So each place is weighed the way Snes9x weighs them
 * (memmap.c, ScoreLoROM and ScoreHiROM), and the best has to look like a header at all. The checksum counts
 * for a header and is not insisted on: translations and hacks often have a wrong one.
 *
 *   { skip: 0 | 512, at, mapping: 'LoROM' | 'HiROM' | 'ExHiROM', title, chip: the cartridge type byte, bytes, score }
 */
function romInfo(b) {
    if (!b || b.length < 0x8000) return null;
    const skip = (b.length & 0x3ff) === 512 ? 512 : 0, n = b.length - skip;
    if (n < 0x8000 || n > MAX_ROM) return null;
    let best = null;
    [[0x7fc0, 'LoROM'], [0xffc0, 'HiROM'], [0x40ffc0, 'ExHiROM']].forEach((c) => {
        const h = skip + c[0];
        if (h + 0x40 > b.length) return;
        const map = b[h + 0x15], reset = b[h + 0x3c] | (b[h + 0x3d] << 8);
        const sum = b[h + 0x1e] | (b[h + 0x1f] << 8), inv = b[h + 0x1c] | (b[h + 0x1d] << 8);
        let score = 0, text = 0;
        for (let i = 0; i < 21; i++) if (printable(b[h + i])) text++;
        // what Snes9x weighs
        if (c[1] === 'LoROM') { if (!(map & 1)) score += 3; if (map === 0x23) score += 2; } else { if (map & 1) score += 2; if (map === 0x23) score -= 2; }
        if (c[1] === 'ExHiROM') score += (map & 0xf) === 5 ? 4 : -4;
        if (sum + inv === 0xffff) { score += 2; if (sum) score++; }
        if (b[h + 0x1a] === 0x33) score += 2;                          // the newer header's marker in the maker byte
        if ((map & 0xf) < 4) score += 2;
        if (!(reset & 0x8000)) score -= 6;                             // the game starts in ROM, which is the upper half
        if (reset > 0xffb0) score -= 2;
        if (b[h + 0x17] > 13) score -= 1;                              // more than 8 MB of ROM
        if (text < 21) score -= 1;
        // what a header has and other bytes seldom do
        const looks = ((map & 0xe0) === 0x20 ? 1 : 0) + (sum + inv === 0xffff ? 1 : 0) + (text === 21 ? 1 : 0) + (b[h + 0x17] >= 7 && b[h + 0x17] <= 13 ? 1 : 0);
        if (!best || score > best.score) best = { skip, at: h, mapping: c[1], score, looks, reset, title: Buffer.from(b.slice(h, h + 21)).toString('latin1').replace(/[^\x20-\x7e]/g, ' ').trim(), chip: b[h + 0x16], bytes: n };
    });
    // a game: it starts in ROM, and its header has at least two more of a header's marks
    if (!best || !(best.reset & 0x8000) || best.looks < 2) return null;
    return best;
}
/** an SNES game file? */
function isRom(b) { return !!romInfo(b); }

class Snes {
    constructor(opts) {
        this.o = opts;
        this.log = opts.log || console;
        this.mod = null;                 // the compiled module (kept: a new instance needs no compile)
        this.x = null;                   // the instance's exports
        this.mem = null;
        this.loaded = false;
        this.dead = null;                // the error that ended this instance
        this.vars = {};                  // core options, set again on every new instance
        this.crop = [0, 0, 0, 0];
        this.shrink = false;
        this.drawing = 1;
        this.out = '';
        this.onDead = null;
    }

    /** Compile snes.wasm: a Promise. Off the main thread, so the menu stays alive meanwhile. */
    compile() {
        if (this.compiling) return this.compiling;
        const t = Date.now();
        this.compiling = WebAssembly.compile(fs.readFileSync(this.o.wasm)).then((mod) => {
            this.mod = mod;
            this.log.info('snes: emulator compiled in ' + (Date.now() - t) + ' ms');
            return this;
        });
        return this.compiling;
    }
    get ready() { return !!this.mod; }

    /* ---------- memory (views are made fresh: memory.grow detaches them) ---------- */
    get u8() { return new Uint8Array(this.mem.buffer); }
    /** the core's memory in bytes (all of it from the start: it must never grow), 0 before a game */
    get memoryBytes() { return this.mem ? this.mem.buffer.byteLength : 0; }
    bytes(p, n) { return new Uint8Array(this.mem.buffer, p, n); }
    str(p, n) { return Buffer.from(this.mem.buffer, p, n).toString('utf8'); }
    /** a C string in the core's memory (freed by the caller with mgu_free) */
    cstr(s) {
        const b = Buffer.from(String(s) + '\0', 'utf8'), p = this.x.mgu_alloc(b.length);
        this.u8.set(b, p);
        return p;
    }

    imports() {
        const self = this;
        const w = {
            // no arguments and no environment (the C library ends the program when it cannot ask: getenv's first call)
            args_sizes_get(pn, psize) { const dv = new DataView(self.mem.buffer); dv.setUint32(pn, 0, true); dv.setUint32(psize, 0, true); return E.OK; },
            args_get() { return E.OK; },
            environ_sizes_get(pn, psize) { const dv = new DataView(self.mem.buffer); dv.setUint32(pn, 0, true); dv.setUint32(psize, 0, true); return E.OK; },
            environ_get() { return E.OK; },
            fd_close() { return E.OK; },
            fd_fdstat_get(fd, p) {
                if (fd > 2) return E.BADF;
                const u = self.u8;
                for (let i = 0; i < 24; i++) u[p + i] = 0;
                u[p] = 2;                                        // a character device
                return E.OK;
            },
            fd_prestat_get() { return E.BADF; },                // no folders at all
            fd_prestat_dir_name() { return E.BADF; },
            fd_read() { return E.BADF; },
            fd_seek(fd) { return fd <= 2 ? E.SPIPE : E.BADF; },
            fd_tell() { return E.BADF; },
            fd_write(fd, iovs, n, nwritten) {
                if (fd !== 1 && fd !== 2) return E.BADF;
                let total = 0;
                for (let i = 0; i < n; i++) {
                    const dv = new DataView(self.mem.buffer), b = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
                    self.print(self.str(b, len));
                    total += len;
                }
                new DataView(self.mem.buffer).setUint32(nwritten, total, true);
                return E.OK;
            },
            clock_time_get(id, lo, hi, p) {                      // (64-bit arguments arrive split: binaryen's --legalize-js-interface)
                const ms = self.o.now ? self.o.now() : Date.now(), dv = new DataView(self.mem.buffer);
                dv.setUint32(p, (ms % 4294967.296) * 1000000 >>> 0, true);            // nanoseconds, low and high word
                dv.setUint32(p + 4, Math.floor(ms / 4294967.296) >>> 0, true);
                return E.OK;
            },
            path_open() { return E.NOENT; },
            path_filestat_get() { return E.NOENT; },
            proc_exit(code) { throw new Error('snes: the emulator exited (' + code + ')'); },
            random_get(p, n) { const u = self.u8; for (let i = 0; i < n; i++) u[p + i] = (Math.random() * 256) | 0; return E.OK; },
        };
        const env = {
            js_log(level, p, n) {
                const s = self.str(p, n).trim();
                if (s) self.log[LEVELS[level] || 'info']('snes: ' + s);
            },
        };
        const imp = { wasi_snapshot_preview1: w, env };
        // anything else a rebuilt core asks for: "not supported"
        WebAssembly.Module.imports(this.mod).forEach((i) => {
            if (i.kind === 'function' && imp[i.module] && !imp[i.module][i.name]) imp[i.module][i.name] = () => E.NOSYS;
        });
        return imp;
    }

    print(s) {
        this.out += s;
        let i;
        while ((i = this.out.indexOf('\n')) >= 0) { const line = this.out.slice(0, i).trim(); this.out = this.out.slice(i + 1); if (line) this.log.info('snes: ' + line); }
    }

    /** a fresh instance of the compiled module (the first, or after a crash) */
    boot() {
        if (!this.mod) throw new Error('snes: the emulator is not compiled yet');
        const inst = new WebAssembly.Instance(this.mod, this.imports());
        this.x = inst.exports;
        this.mem = this.x.memory;
        this.dead = null;
        this.loaded = false;
        if (this.x._initialize) this.x._initialize();
        this.x.mgu_init();
        Object.keys(this.vars).forEach((k) => this._var(k, this.vars[k]));
        this.x.mgu_set_crop(this.crop[0], this.crop[1], this.crop[2], this.crop[3]);
        this.x.mgu_set_shrink(this.shrink ? 1 : 0);
        this.drawing = 1;
    }
    /** Let go of the game, the instance and the compiled module: their memory is the app's again. compile() starts over. */
    close() {
        this.unload();
        this.x = null; this.mem = null; this.mod = null; this.compiling = null; this.dead = null; this.loaded = false;
    }

    /** run fn inside the core; a trap ends the instance (onDead) and gives `otherwise` */
    guard(fn, otherwise) {
        if (this.dead || !this.x) return otherwise;
        try { return fn(); } catch (e) {
            this.dead = e;
            this.loaded = false;
            this.log.error('snes: the emulator crashed', e);
            if (this.onDead) try { this.onDead(e); } catch (e2) { this.log.error(e2); }
            return otherwise;
        }
    }

    _var(key, value) {
        const k = this.cstr(key), v = this.cstr(value);
        this.x.mgu_set_var(k, v);
        this.x.mgu_free(k); this.x.mgu_free(v);
    }
    /** a core option (the core's libretro_core_options.h); kept for later instances */
    setVar(key, value) {
        value = String(value);
        if (this.vars[key] === value) return;
        this.vars[key] = value;
        this.guard(() => this._var(key, value));
    }
    /**
     * A picture with twice the console's pixels (512 wide, 448 high: the high-resolution modes a few games use
     * for menus and text) made the console's own size by averaging, so it is drawn in whole screen pixels like
     * every other, and is no more bytes to hand over. Kept for later instances.
     */
    setShrink(on) {
        this.shrink = !!on;
        this.guard(() => this.x.mgu_set_shrink(this.shrink ? 1 : 0));
    }
    /** pixels cut off each side of the picture: left, top, right, bottom */
    setCrop(l, t, r, b) {
        this.crop = [l | 0, t | 0, r | 0, b | 0];
        this.guard(() => this.x.mgu_set_crop(this.crop[0], this.crop[1], this.crop[2], this.crop[3]));
    }

    /** Start a game from its ROM file's bytes. false: not a ROM the core takes. */
    load(rom) {
        const info = romInfo(rom);
        if (!info) return false;
        if (!this.x || this.dead) this.boot();
        const ok = this.guard(() => {
            const n = info.bytes, p = this.x.mgu_alloc(n);   // (the core frees it with the game)
            if (!p) return false;
            this.u8.set(info.skip ? rom.slice(info.skip) : rom, p);   // without a copier's header
            return !!this.x.mgu_load(p, n);
        }, false);
        this.loaded = ok;
        if (ok) this.fps = this.x.mgu_fps_milli() / 1000;
        return ok;
    }
    unload() { if (this.loaded) { this.guard(() => this.x.mgu_unload()); this.loaded = false; } }

    /** the pad's buttons held now: an OR of BTN masks (port 0 = player 1) */
    setPad(port, mask) { if (this.loaded) this.guard(() => this.x.mgu_set_pad(port, mask)); }
    /**
     * One video frame. true: a new picture is in frame(). draw false: the frame is run and heard but not drawn
     * (the core leaves its picture as it was), which is what a frame costs least.
     */
    run(draw) {
        if (!this.loaded) return false;
        const d = draw === false ? 0 : 1;
        return !!this.guard(() => { if (d !== this.drawing) { this.drawing = d; this.x.mgu_set_draw(d); } return this.x.mgu_run(); }, 0);
    }
    /** the last picture: { px: RGBA bytes (a view into the core's memory, valid until the next call into it), w, h } */
    frame() {
        if (!this.loaded) return null;
        const w = this.x.mgu_frame_w(), h = this.x.mgu_frame_h(), p = this.x.mgu_frame_ptr();
        return p && w && h ? { px: this.bytes(p, w * h * 4), w, h } : null;
    }
    /**
     * The sound of the frame just run: { bytes: signed 16-bit little-endian, left and right (a view into the
     * core's memory, valid until the next call into it), frames }, or null. sampleRate: its samples a second.
     */
    audio() {
        if (!this.loaded) return null;
        const n = this.x.mgu_audio_frames(), p = this.x.mgu_audio_ptr();
        return p && n ? { bytes: this.bytes(p, n * 4), frames: n } : null;
    }
    get sampleRate() { return this.loaded ? this.guard(() => this.x.mgu_sample_rate(), 0) : 0; }
    /** the console's reset button */
    reset() { if (this.loaded) this.guard(() => this.x.mgu_reset()); }

    /** The whole machine as a Buffer (a save state), or null. */
    saveState() {
        if (!this.loaded) return null;
        return this.guard(() => {
            const n = this.x.mgu_state_size();
            if (!n) return null;
            const p = this.x.mgu_alloc(n);
            if (!p) return null;
            const ok = this.x.mgu_state_save(p, n);
            const b = ok ? Buffer.from(this.bytes(p, n)) : null;     // a copy
            this.x.mgu_free(p);
            return b;
        }, null);
    }
    loadState(b) {
        if (!this.loaded || !b || !b.length) return false;
        return this.guard(() => {
            const p = this.x.mgu_alloc(b.length);
            if (!p) return false;
            this.u8.set(b, p);
            const ok = !!this.x.mgu_state_load(p, b.length);
            this.x.mgu_free(p);
            return ok;
        }, false);
    }

    /** the cartridge's battery memory: a copy, or null when the game has none */
    sram() {
        if (!this.loaded) return null;
        return this.guard(() => {
            const n = this.x.mgu_sram_size(), p = this.x.mgu_sram_ptr();
            return n && p ? Buffer.from(this.bytes(p, n)) : null;
        }, null);
    }
    /** put saved battery memory back (right after load(), before the first frame) */
    setSram(b) {
        if (!this.loaded || !b) return false;
        return this.guard(() => {
            const n = this.x.mgu_sram_size(), p = this.x.mgu_sram_ptr();
            if (!n || !p || b.length !== n) return false;
            this.u8.set(b, p);
            return true;
        }, false);
    }
}

module.exports = { Snes, BTN, isRom, romInfo, MAX_ROM };
