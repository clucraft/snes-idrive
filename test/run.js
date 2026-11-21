'use strict';

// SNES app: what counts as a game file (snes-core.js, romInfo), the emulator (app/snes.wasm and app/snes-plus.wasm
// through snes-core.js) on a small cartridge made here, the controller -> pad mapping (controls.js), the tabs of
// the game's screen (tabs.js: the list of games, the settings, and what steers them), the games / saves on disk
// (library.js) and the game that comes with the app (app/games/), played in the emulator. "Add games from a
// phone": the QR code (qr.js) and the SNES game loader (loader/) from the app's request to a game sent over
// HTTP, with a stand-in for the head unit's firewall program. A USB gamepad: what its packets mean
// (loader/pad.js), and its buttons from a stand-in for the program that reads it (test/fake-usbpipe.js) through
// the loader to the app. A game's sound: out of the emulator, through the loader to a stand-in for the program
// that plays it (test/fake-sound.js), that program itself where it runs (Linux), and the request for the car's
// speakers. Then the MGU Store's view of this repository: mgu-repo.json and the committed package in store/.
// No SDK, head unit or game needed; runs on Node 8 (the head unit's) as on a current one:
//   node test/run.js        (npm test; npm run test:node8 for Node 8)
//
// Most of it is the NES project's suite (clucraft/nes-idrive, test/run.js), with what an SNES changes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { Snes, BTN, isRom, romInfo, MAX_ROM } = require(path.join(ROOT, 'app/snes-core'));
const { Controls, TAP, GAP, SEEN } = require(path.join(ROOT, 'app/controls'));
const { Library, titleOf, openPack, usbFolders } = require(path.join(ROOT, 'app/library'));
const { unpack } = require(path.join(ROOT, 'tools/tar'));
const { spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const { qr } = require(path.join(ROOT, 'app/qr'));
const { Phone } = require(path.join(ROOT, 'app/phone'));
const { Pad, PAD, toSnes, wantsOut } = require(path.join(ROOT, 'app/pad'));
const { Tabs } = require(path.join(ROOT, 'app/tabs'));
const { Sound, ahead } = require(path.join(ROOT, 'app/sound'));
const { createCarAudio } = require(path.join(ROOT, 'app/caraudio'));
const loader = { games: require(path.join(ROOT, 'loader/games')), nft: require(path.join(ROOT, 'loader/nft')), service: require(path.join(ROOT, 'loader/service')), pad: require(path.join(ROOT, 'loader/pad')), page: require(path.join(ROOT, 'loader/page')), sound: require(path.join(ROOT, 'loader/sound')) };

let failed = 0;
const check = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
};
const log = { info() {}, debug() {}, warn() {}, error(s, e) { console.log('     ' + s + ' ' + ((e && e.message) || '')); } };

/** the header's checksum and its complement, as a cartridge has them: the sum of every byte of the ROM */
function sign(rom, at) {
    rom[at + 0x1c] = 0xff; rom[at + 0x1d] = 0xff; rom[at + 0x1e] = 0; rom[at + 0x1f] = 0;
    let sum = 0;
    for (let i = 0; i < rom.length; i++) sum = (sum + rom[i]) & 0xffff;
    rom[at + 0x1e] = sum & 255; rom[at + 0x1f] = sum >> 8;
    rom[at + 0x1c] = ~sum & 255; rom[at + 0x1d] = (~sum >> 8) & 255;
    return rom;
}
/**
 * A cartridge of our own: 128 KB LoROM with 8 KB of battery memory. Each frame it reads pad 1 (the console's
 * own reading of it, $4218) and makes the whole screen blue, or red while A is held. No layer is on: the
 * picture is the backdrop colour. hires: in the console's high-resolution mode (mode 5, interlaced), which a
 * core draws with twice the pixels each way.
 */
function testRom(hires) {
    const rom = Buffer.alloc(131072, 0xff), code = [
        0x78, 0x18, 0xfb, 0xe2, 0x30,                         // 8000 SEI, CLC, XCE (native mode), SEP #$30 (8-bit A, X, Y)
        0xa9, 0x8f, 0x8d, 0x00, 0x21,                         // 8005 LDA #$8F, STA $2100 (screen off)
        0x9c, 0x2c, 0x21, 0x9c, 0x2d, 0x21,                   // 800A STZ $212C, STZ $212D (no layers)
        0xa9, 0x01, 0x8d, 0x00, 0x42,                         // 8010 LDA #1, STA $4200 (the console reads the pads each frame; no NMI)
        0xad, 0x12, 0x42, 0x10, 0xfb,                         // 8015 LDA $4212, BPL 8015 (vertical blank)
        0xad, 0x12, 0x42, 0x29, 0x01, 0xd0, 0xf9,             // 801A LDA $4212, AND #1, BNE 801A (the pads are read)
        0xad, 0x18, 0x42, 0x29, 0x80, 0xf0, 0x0d,             // 8021 LDA $4218, AND #$80 (A), BEQ 8035
        0x9c, 0x21, 0x21, 0xa9, 0x1f, 0x8d, 0x22, 0x21, 0x9c, 0x22, 0x21,   // 8028 colour 0 = $001F, red
        0x80, 0x0b,                                           // 8033 BRA 8040
        0x9c, 0x21, 0x21, 0x9c, 0x22, 0x21, 0xa9, 0x7c, 0x8d, 0x22, 0x21,   // 8035 colour 0 = $7C00, blue
        0xa9, 0x0f, 0x8d, 0x00, 0x21,                         // 8040 LDA #$0F, STA $2100 (screen on)
        0xad, 0x12, 0x42, 0x30, 0xfb,                         // 8045 LDA $4212, BMI 8045 (the blank is over)
        0x4c, 0x15, 0x80,                                     // 804A JMP 8015
        0x40,                                                 // 804D RTI
    ];
    if (hires) {
        // in place of "no layers": mode 5 and an interlaced picture, then on to 8015
        const more = [0xa9, 0x05, 0x8d, 0x05, 0x21,           // 8050 LDA #5, STA $2105
            0xa9, 0x01, 0x8d, 0x33, 0x21,                     // 8055 LDA #1, STA $2133
            0xa9, 0x01, 0x8d, 0x00, 0x42,                     // 805A LDA #1, STA $4200
            0x4c, 0x15, 0x80];                                // 805F JMP 8015
        Buffer.from(more).copy(rom, 0x50);
        code.splice(16, 5, 0x4c, 0x50, 0x80, 0xea, 0xea);     // 8010 JMP 8050
    }
    Buffer.from(code).copy(rom, 0);
    const h = 0x7fc0;
    Buffer.from('SNES IDRIVE TEST     ', 'ascii').copy(rom, h);
    rom[h + 0x15] = 0x20;                                     // LoROM
    rom[h + 0x16] = 0x02;                                     // ROM, RAM and a battery
    rom[h + 0x17] = 0x07;                                     // 128 KB of ROM
    rom[h + 0x18] = 0x03;                                     // 8 KB of RAM
    rom[h + 0x19] = 0x01;                                     // North America: 60 Hz
    rom[h + 0x1a] = 0x00; rom[h + 0x1b] = 0x00;
    for (let v = 0x24; v < 0x40; v += 2) { rom[h + v] = 0x4d; rom[h + v + 1] = 0x80; }     // every vector: the RTI
    rom[h + 0x3c] = 0x00; rom[h + 0x3d] = 0x80;               // reset: 8000
    return sign(rom, h);
}
/** of sound as signed 16-bit left and right: { frames, peak, cycles: times the left goes from below its middle to above } */
function heard(bytes) {
    const b = Buffer.from(bytes), n = b.length >> 2;
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 4); if (v < lo) lo = v; if (v > hi) hi = v; }
    const mid = (lo + hi) / 2;
    let cycles = 0, below = true;
    for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 4); if (below && v > mid + (hi - mid) / 4) { cycles++; below = false; } else if (v < mid - (mid - lo) / 4) below = true; }
    return { frames: n, peak: Math.max(-lo, hi), swing: hi - lo, cycles };
}
/** the picture's one colour as [r, g, b], or null when it has more than one */
function colour(f) {
    for (let i = 4; i < f.px.length; i += 4) if (f.px[i] !== f.px[0] || f.px[i + 1] !== f.px[1] || f.px[i + 2] !== f.px[2]) return null;
    return [f.px[0], f.px[1], f.px[2]];
}
const frames = (snes, n, pad) => { for (let i = 0; i < n; i++) { snes.setPad(0, pad || 0); snes.run(); } return snes.frame(); };
/** the picture after n more frames, as a copy (the core's own is only good until it runs again) */
const shot = (snes, n, pad) => { const f = frames(snes, n, pad); return { w: f.w, h: f.h, px: new Uint8Array(f.px) }; };
/** a copy of the tiles from column x, row y of the picture (8 x 8 pixels each), n of them in a row */
const tiles = (f, x, y, n) => { const out = []; for (let r = y * 8; r < y * 8 + 8; r++) out.push(Buffer.from(f.px.buffer, f.px.byteOffset + (r * f.w + x * 8) * 4, n * 32)); return Buffer.concat(out); };
/** the colour in the middle of the tile at column x, row y */
const middle = (f, x, y) => { const i = ((y * 8 + 4) * f.w + x * 8 + 4) * 4; return [f.px[i], f.px[i + 1], f.px[i + 2]]; };
/** the game that comes with the app, and no other */
const BUNDLED = ['Pad_Test.sfc'];
/** a data pack as kit/tools/pack_data.py writes it */
function writePack(file, files) {
    const index = {}, blobs = [];
    let off = 0;
    Object.keys(files).forEach((n) => { const z = zlib.deflateRawSync(files[n]); index[n] = [off, z.length]; off += z.length; blobs.push(z); });
    const ix = zlib.deflateRawSync(Buffer.from(JSON.stringify({ files: index, split: {} }))), len = Buffer.alloc(4);
    len.writeUInt32LE(ix.length, 0);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('MGUPACK1'), len, ix].concat(blobs)));
}

(async () => {
    console.log('node ' + process.version);
    const rom = testRom();
    const WASM = path.join(ROOT, 'app/snes.wasm'), PLUS = path.join(ROOT, 'app/snes-plus.wasm');
    const snes = new Snes({ wasm: WASM, log });

    /* ---------- what is a game ---------- */
    await check('game files: the test cartridge is one (LoROM, its title, its size)', () => {
        const i = romInfo(rom);
        assert(i && isRom(rom), 'not taken for a game');
        assert(i.mapping === 'LoROM' && i.title === 'SNES IDRIVE TEST' && i.skip === 0 && i.bytes === 131072 && i.chip === 2, JSON.stringify(i));
    });
    await check('game files: a copier\'s 512 bytes in front (.smc) are seen and left out', () => {
        const smc = Buffer.concat([Buffer.alloc(512), rom]), i = romInfo(smc);
        assert(i && i.skip === 512 && i.bytes === 131072 && i.title === 'SNES IDRIVE TEST', JSON.stringify(i));
    });
    await check('game files: a wrong checksum is still a game (translations and hacks have them)', () => {
        const hack = Buffer.from(rom);
        hack[0x7fde] ^= 0x5a; hack[0x7fdc] ^= 0x33; hack[0x100] = 0x12;
        assert(isRom(hack), 'refused');
    });
    const hiRom = () => {
        const hi = Buffer.alloc(1048576, 0xff), h = 0xffc0;
        Buffer.from('HIROM TEST           ', 'ascii').copy(hi, h);
        hi[h + 0x15] = 0x21; hi[h + 0x16] = 0x00; hi[h + 0x17] = 0x0a; hi[h + 0x18] = 0x00; hi[h + 0x19] = 0x01; hi[h + 0x1a] = 0x01;
        hi[h + 0x3c] = 0x00; hi[h + 0x3d] = 0x80;
        return sign(hi, h);
    };
    await check('game files: a HiROM game is found at its own place', () => {
        const i = romInfo(hiRom());
        assert(i && i.mapping === 'HiROM' && i.title === 'HIROM TEST', JSON.stringify(i));
    });
    const NOT_GAMES = () => {
        const nes = Buffer.concat([Buffer.from([0x4e, 0x45, 0x53, 0x1a, 2, 1]), Buffer.alloc(10), Buffer.alloc(40960, 0xea)]);
        const text = Buffer.from(new Array(4000).join('All work and no play makes Jack a dull boy.\n'));
        return [['nothing', null], ['an empty file', Buffer.alloc(0)], ['zeros', Buffer.alloc(262144)], ['0xFF', Buffer.alloc(262144, 0xff)], ['text', text],
            ['an NES game', nes], ['this script', fs.readFileSync(__filename)], ['the emulator itself', fs.readFileSync(WASM)], ['a program', fs.readFileSync(path.join(ROOT, 'loader/snes-usbpipe'))]];
    };
    await check('game files: other files are none (text, zeros, an NES game, this script, the emulator, a program)', () => {
        NOT_GAMES().forEach((c) => assert(!isRom(c[1]), c[0] + ' was taken for a game'));
    });
    await check('game files: too small and too big are refused', () => {
        assert(!isRom(rom.slice(0, 16384)), '16 KB taken');
        const big = Buffer.alloc(MAX_ROM + 32768, 0xff);
        rom.copy(big, 0);
        assert(!isRom(big), 'over ' + MAX_ROM + ' bytes taken');
    });
    await check('game files: the loader, which is installed by itself, takes and refuses the same files as the app', () => {
        const yes = [rom, Buffer.concat([Buffer.alloc(512), rom]), hiRom(), fs.readFileSync(path.join(ROOT, 'app/games/Pad_Test.sfc'))];
        yes.forEach((b, i) => { assert.deepStrictEqual(loader.games.romInfo(b), romInfo(b), 'game ' + i + ' is read differently'); assert.strictEqual(loader.games.refuse(b), null, 'game ' + i + ' refused'); });
        NOT_GAMES().forEach((c) => { assert.strictEqual(loader.games.romInfo(c[1]), null, c[0] + ' is a game to the loader'); assert(loader.games.refuse(c[1]), c[0] + ' not refused'); });
        assert.strictEqual(loader.games.MAX_ROM, MAX_ROM);
        // (the two functions are one text)
        const fn = (file) => { const s = fs.readFileSync(path.join(ROOT, file), 'utf8'), a = s.indexOf('function romInfo(b) {'); return s.slice(a, s.indexOf('\n}\n', a)); };
        assert.strictEqual(fn('loader/games.js'), fn('app/snes-core.js'), 'loader/games.js and app/snes-core.js have two different romInfo');
    });

    /* ---------- the emulator ---------- */
    let mem0 = 0;
    await check('core: snes.wasm compiles and a cartridge loads', async () => {
        await snes.compile();
        assert(snes.load(rom), 'the test cartridge did not load');
        mem0 = snes.memoryBytes;
        assert(snes.fps > 59.5 && snes.fps < 60.5, 'frame rate ' + snes.fps);
    });
    let blue, red;
    await check('core: the picture is 256 x 224 RGBA, one opaque colour from the test program', () => {
        const f = frames(snes, 30);
        assert(f && f.w === 256 && f.h === 224 && f.px.length === 256 * 224 * 4, 'picture ' + (f && f.w + 'x' + f.h));
        blue = colour(f);
        assert(blue, 'more than one colour on the screen');
        assert(f.px[3] === 255, 'alpha ' + f.px[3]);
        assert(blue[2] > 200 && blue[0] < 40 && blue[1] < 40, 'not blue: ' + blue);
    });
    await check('core: pad 1\'s A reaches the game (the screen turns red), no other button does, and letting go turns it back', () => {
        red = colour(frames(snes, 6, BTN.A));
        assert(red && red[0] > 200 && red[2] < 40, 'not red with A held: ' + red);
        const others = BTN.B | BTN.Y | BTN.X | BTN.L | BTN.R | BTN.START | BTN.SELECT | BTN.RIGHT | BTN.UP;
        assert.deepStrictEqual(colour(frames(snes, 6, others)), blue, 'other buttons are not A');
        assert.deepStrictEqual(colour(frames(snes, 6, 0)), blue, 'still red after A was let go');
    });
    await check('core: a save state brings the same machine back, also into a new instance', async () => {
        frames(snes, 6, BTN.A);
        const st = snes.saveState();
        assert(st && st.length > 1000, 'no state');
        assert.deepStrictEqual(colour(frames(snes, 8)), blue);
        assert(snes.loadState(st), 'state did not load');
        assert.deepStrictEqual(colour(frames(snes, 1, BTN.A)), red, 'after the state: the screen it was saved with');
        const other = new Snes({ wasm: WASM, log });
        other.mod = snes.mod;                                 // (the compiled module is shared)
        assert(other.load(rom) && other.loadState(st), 'state did not load into a new instance');
        assert.deepStrictEqual(colour(frames(other, 2, BTN.A)), red);
        snes.loadState(Buffer.alloc(64, 1));                  // (what is no state must not end the instance, taken or not)
        assert(snes.loaded && !snes.dead, 'the instance ended on a state that is none');
    });
    await check('core: the cartridge\'s battery memory is 8 KB, can be read and put back', () => {
        assert(snes.load(rom));
        const a = snes.sram();
        assert(a && a.length === 8192, 'battery memory ' + (a && a.length));
        const mine = Buffer.alloc(8192);
        for (let i = 0; i < mine.length; i++) mine[i] = (i * 7) & 255;
        assert(snes.setSram(mine), 'not taken');
        frames(snes, 3);
        assert(snes.sram().equals(mine), 'not what was put in');
        assert(!snes.setSram(Buffer.alloc(100)), 'a wrong size was taken');
    });
    await check('core: what is no cartridge is refused; the next game still loads', () => {
        assert(!snes.load(Buffer.from('not a game')) && !snes.load(Buffer.alloc(40000, 7)));
        assert(snes.load(rom) && colour(frames(snes, 30)), 'no picture after loading again');
    });
    await check('core: a frame that is run and not drawn leaves the picture as it was, and the game goes on', () => {
        assert.deepStrictEqual(colour(frames(snes, 4)), blue);
        const before = Buffer.from(snes.frame().px);
        for (let i = 0; i < 6; i++) { snes.setPad(0, BTN.A); assert.strictEqual(snes.run(false), false, 'a frame not to be drawn gave a picture'); }
        assert(Buffer.from(snes.frame().px).equals(before), 'the picture changed without a frame drawn');
        snes.setPad(0, BTN.A);
        assert.strictEqual(snes.run(), true, 'no picture from a frame that is drawn again');
        assert.deepStrictEqual(colour(snes.frame()), red, 'the game did not see the pad while it was not drawn');
        frames(snes, 4);
    });
    await check('core: a high-resolution picture comes as the core makes it, or shrunk to the console\'s 256 x 224', async () => {
        const hi = new Snes({ wasm: WASM, log });
        hi.mod = snes.mod;
        assert(hi.load(testRom(true)), 'the high-resolution cartridge did not load');
        const f = frames(hi, 30);
        assert(f.w === 512 && f.h === 448, 'picture ' + f.w + 'x' + f.h + ', not 512x448');
        assert.deepStrictEqual(colour(f), blue);
        hi.setShrink(true);
        const g = frames(hi, 2);
        assert(g.w === 256 && g.h === 224 && g.px.length === 256 * 224 * 4, 'shrunk: ' + g.w + 'x' + g.h);
        assert.deepStrictEqual(colour(g), blue, 'shrinking changed the colour');
        assert.deepStrictEqual(colour(frames(hi, 6, BTN.A)), red);
        // the plain picture is left alone
        snes.setShrink(true);
        const p = frames(snes, 2);
        assert(p.w === 256 && p.h === 224, 'a plain picture was shrunk: ' + p.w + 'x' + p.h);
        snes.setShrink(false);
    });
    const padTest = fs.readFileSync(path.join(ROOT, 'app/games/Pad_Test.sfc'));
    /** n frames of a game's sound, with these buttons held: the bytes, as one Buffer */
    const listen = (s, n, pad) => { const parts = []; for (let i = 0; i < n; i++) { s.setPad(0, pad || 0); s.run(); const a = s.audio(); if (a) parts.push(Buffer.from(a.bytes)); } return Buffer.concat(parts); };
    await check('core: a game\'s sound comes with each frame: 32040 samples a second, left and right; Pad Test\'s hum of a held button is 500 Hz', async () => {
        const tone = new Snes({ wasm: WASM, log });
        tone.mod = snes.mod;
        assert.strictEqual(tone.audio(), null, 'sound without a game');
        assert(tone.load(padTest), 'Pad Test did not load');
        assert.strictEqual(tone.sampleRate, 32040);
        frames(tone, 70);
        for (let i = 0; i < 30; i++) {
            tone.setPad(0, BTN.B); tone.run();
            const a = tone.audio();
            assert(a && a.bytes.length === a.frames * 4 && Math.abs(a.frames - 32040 / tone.fps) < 4, 'frame ' + i + ': ' + (a && a.frames) + ' samples');
        }
        // (a stretch that keeps clear of the second's beep: frames 100 to 115 of the clock)
        const h = heard(listen(tone, 12, BTN.B)), seconds = h.frames / 32040;
        assert(h.swing > 2000, 'the hum is not in the sound: ' + JSON.stringify(h));
        assert(Math.abs(h.cycles / seconds - 500) < 12, (h.cycles / seconds).toFixed(1) + ' Hz');
    });
    await check('core: snes-plus.wasm, the same core with blargg\'s sound chip, plays the same games and hums the same note', async () => {
        const plus = new Snes({ wasm: PLUS, log });
        await plus.compile();
        assert(plus.load(rom), 'the test cartridge did not load');
        assert.deepStrictEqual(colour(frames(plus, 30)), blue);
        assert.deepStrictEqual(colour(frames(plus, 6, BTN.A)), red);
        const st = plus.saveState();
        assert(st && st.length > 1000 && plus.loadState(st), 'its own state did not load');
        assert(plus.load(padTest) && plus.sampleRate === 32040, 'Pad Test, or its rate: ' + plus.sampleRate);
        frames(plus, 100);
        const h = heard(listen(plus, 12, BTN.B)), seconds = h.frames / 32040;
        assert(h.swing > 2000 && Math.abs(h.cycles / seconds - 500) < 12, 'the hum: ' + (h.cycles / seconds).toFixed(1) + ' Hz, ' + JSON.stringify(h));
        // the memory is all there from the start for this one too, and given back when the app changes cores
        assert.strictEqual(plus.memoryBytes, 24 << 20);
        plus.close();
        assert(!plus.ready && !plus.loaded && plus.memoryBytes === 0, 'not closed');
        await plus.compile();
        assert(plus.load(rom) && colour(frames(plus, 30)), 'no game after closing and compiling again');
    });
    await check('core: the memory never grows (24 MiB from the start: Node 8 copies on growth)', () => {
        for (let i = 0; i < 20; i++) { assert(snes.load(rom)); frames(snes, 3); snes.saveState(); }
        assert(snes.load(padTest)); frames(snes, 30); snes.saveState();
        assert(snes.load(rom));
        assert.strictEqual(snes.memoryBytes, 24 << 20);
        assert.strictEqual(mem0, 24 << 20);
    });

    /* ---------- controller and buttons -> pad ---------- */
    const ev = (knob, push, tilt) => ({ frontRotaryEncoderOperation: knob, frontRotaryEncoderPushButton: push, frontRotaryEncoderDeflection: tilt });
    let now = 0;
    const set = { press: 'a', turnR: 'b', turnL: 'start' };
    const mk = () => { const c = new Controls({ log, now: () => now, press: () => set.press, turnR: () => set.turnR, turnL: () => set.turnL }); c.enable(true); return c; };
    await check('controls: push holds the D-pad, press holds A (or B, by the setting)', () => {
        const c = mk();
        c.raw(ev(10, 0, 0), true);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 1, 4), true);
        assert.strictEqual(c.mask(), BTN.RIGHT | BTN.A);
        c.raw(ev(10, 2, 'WEST_LANG_GEDRUECKT'), true);        // (the SDK's names work as the numbers do)
        assert.strictEqual(c.mask(), BTN.LEFT | BTN.A);
        set.press = 'b';
        assert.strictEqual(c.mask(), BTN.LEFT | BTN.B);
        set.press = 'a';
        c.raw(ev(10, 0, 0), true);
        assert.strictEqual(c.mask(), 0);
    });
    await check('controls: a push or press that is over before the next frame still reaches the game, for ' + SEEN + ' frames', () => {
        const c = mk();
        c.raw(ev(10, 0, 0), true);
        c.raw(ev(10, 1, 0), true); c.raw(ev(10, 0, 0), true);  // pressed and let go between two frames
        for (let i = 0; i < SEEN; i++) assert.strictEqual(c.mask(), BTN.A, 'frame ' + i);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 0, 1), true); c.raw(ev(10, 0, 0), true);  // and a push
        for (let i = 0; i < SEEN; i++) assert.strictEqual(c.mask(), BTN.UP, 'frame ' + i);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 0, 4), true); c.raw(ev(10, 0, 7), true);  // one direction, then another held on: the one held wins
        assert.strictEqual(c.mask(), BTN.DOWN);
        c.enable(false);
        c.raw(ev(10, 1, 0), true); c.raw(ev(10, 0, 0), true);  // a press while the game is stopped is not kept for its start
        c.enable(true);
        assert.strictEqual(c.mask(), 0);
    });
    await check('controls: each knob click is one tap (' + TAP + ' frames held, ' + GAP + ' let go); the first message only says where the knob stands', () => {
        const c = mk(), seq = () => { const s = []; for (let i = 0; i < 2 * (TAP + GAP) + 2; i++) s.push(c.mask()); return s; };
        c.raw(ev(65535, 0, 0), true);
        assert.strictEqual(c.mask(), 0, 'the first message tapped');
        c.raw(ev(1, 0, 0), true);                             // two clicks to the right, over the counter's wrap
        const s = seq(), want = [];
        for (let k = 0; k < 2; k++) { for (let i = 0; i < TAP; i++) want.push(BTN.B); for (let i = 0; i < GAP; i++) want.push(0); }
        assert.deepStrictEqual(s.slice(0, want.length), want);
        assert.deepStrictEqual(s.slice(want.length), [0, 0]);
        c.raw(ev(0, 0, 0), true);                             // one to the left
        assert.strictEqual(c.mask(), BTN.START);
        set.turnL = 'none';
        c.raw(ev(65535, 0, 0), true);
        for (let i = 0; i < TAP + GAP; i++) c.mask();
        assert.strictEqual(c.mask(), 0, '"Nothing" tapped');
        set.turnL = 'start';
    });
    await check('controls: a touch button taps; the HMI pressing one for the knob\'s own press does not', () => {
        const c = mk();
        assert(c.bar('BTN_SELECT') && c.mask() === BTN.SELECT && c.lit('BTN_SELECT') > 0);
        now += 1000;
        assert.strictEqual(c.lit('BTN_SELECT'), 0);
        c.raw(ev(5, 0, 0), false); c.raw(ev(5, 1, 0), false); // no controller gate: the HMI gets this press too
        assert(!c.bar('BTN_START'), 'the HMI\'s press counted as a tap');
        now += 1000;
        c.raw(ev(5, 0, 0), false);
        assert(c.bar('BTN_START'));
    });
    await check('controls: nothing while the game is stopped; a lost release is let go after 1.5 s', () => {
        const c = mk();
        c.raw(ev(3, 0, 0), true); c.raw(ev(3, 1, 7), true);
        c.enable(false);
        assert.strictEqual(c.mask(), 0);
        assert(!c.bar('BTN_A'));
        c.enable(true);
        assert.strictEqual(c.mask(), BTN.DOWN | BTN.A);
        for (let i = 0; i < 6; i++) c.raw(ev(3, 1, 7), true);  // the car repeats its messages...
        now += 2000;                                           // ...and then none comes
        assert.strictEqual(c.mask(), 0);
        c.setExternal(BTN.LEFT | BTN.RIGHT | BTN.A);           // (another pad: opposite directions cancel)
        assert.strictEqual(c.mask(), BTN.A);
        c.setExternal(BTN.B);
        c.enable(false); c.enable(true);                       // its buttons are let go with the game: no button stuck at the next start
        assert.strictEqual(c.mask(), 0);
    });

    await check('controls: while the tabs show, the controller and the four touch buttons steer them; the press that chose a game is not the game\'s until it was let go', () => {
        const got = [];
        const c = new Controls({ log, now: () => now, press: () => 'a', turnR: () => 'b', turnL: () => 'start', nav: (e) => got.push(e) });
        c.raw(ev(7, 0, 0), true);
        c.raw(ev(9, 0, 0), true);                              // nobody asked for the tabs yet
        assert.deepStrictEqual(got, []);
        c.navigate(true);
        c.raw(ev(11, 0, 0), true); c.raw(ev(10, 0, 0), true);
        c.raw(ev(10, 0, 1), true); c.raw(ev(10, 0, 2), true); c.raw(ev(10, 0, 0), true);    // pushed up, held on, let go: one push
        c.raw(ev(10, 0, 'OST_KURZ_GEDRUECKT'), true); c.raw(ev(10, 0, 7), true); c.raw(ev(10, 0, 10), true); c.raw(ev(10, 0, 0), true);
        c.raw(ev(10, 1, 0), true);
        assert.deepStrictEqual(got, [{ turn: 2 }, { turn: -1 }, { push: 'N' }, { push: 'E' }, { push: 'S' }, { push: 'W' }, { press: true }]);
        assert.strictEqual(c.mask(), 0, 'a button for a game while the tabs show');
        got.length = 0; now += 1000;
        ['BTN_SELECT', 'BTN_START', 'BTN_B', 'BTN_A'].forEach((b) => assert(c.bar(b), b));
        assert.deepStrictEqual(got, [{ tab: 1 }, { push: 'N' }, { push: 'S' }, { press: true }]);
        // the game starts with the press still down, and a gamepad's A and D-pad with it
        c.setExternal(BTN.A | BTN.RIGHT);
        c.enable(true); c.navigate(false);
        assert.strictEqual(c.mask(), 0, 'the press that chose the game reached it');
        c.setExternal(BTN.RIGHT); c.raw(ev(10, 0, 0), true);   // A let go, on both
        c.setExternal(BTN.RIGHT | BTN.A); c.raw(ev(10, 1, 0), true);
        assert.strictEqual(c.mask(), BTN.A, 'pressed anew it is the game\'s; what was never let go is not');
        got.length = 0;
        c.raw(ev(12, 0, 0), true);
        assert.deepStrictEqual(got, [], 'the tabs steered while a game runs');
        // and as it happens in the app: the game starts while the tabs are told of the press
        const d = new Controls({ log, now: () => now, press: () => 'a', turnR: () => 'b', turnL: () => 'start', nav: (e) => { if (e.press) { d.enable(true); d.navigate(false); } } });
        d.navigate(true);
        d.raw(ev(3, 0, 0), true); d.raw(ev(3, 1, 0), true);
        assert(d.enabled && d.mask() === 0, 'the press that started the game was its first button');
        d.raw(ev(3, 0, 0), true); d.raw(ev(3, 1, 0), true);
        assert.strictEqual(d.mask(), BTN.A);
    });

    /* ---------- the tabs of the game's screen (tabs.js) ---------- */
    {
        // (a stand-in for the kit's Recorder: what was written where)
        const paper = () => {
            const said = [];
            const r = { said, text(s, x, y, size) { said.push(String(s)); return String(s).length * size * 0.5; }, textWidth: (s, size) => String(s).length * size * 0.5 };
            ['roundRect', 'strokeRoundRect', 'fillRect', 'circle'].forEach((k) => { r[k] = () => r; });
            return r;
        };
        const kept = (schema) => {
            const v = {};
            schema.forEach((s) => { v[s.key] = s.default; });
            return { schema, v, get: (k) => v[k], set: (k, x) => { v[k] = x; }, shown: (s) => !s.hidden, display: (k) => 'is ' + v[k] };
        };
        const games = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima'.split(' ').map((t, i) => ({ id: 'g' + i, title: t }));
        await check('tabs: the games by title under the one played last; the controller goes through them, a press plays one, "Start over" beside it from power-on', () => {
            const played = [], opened = [];
            let cur = games[3];
            const tabs = new Tabs({ games: () => games, current: () => cur, settings: kept([]), onPlay: (g, fresh) => played.push([g.id, fresh]), onTab: (n) => opened.push(n) });
            tabs.open('games');
            assert.deepStrictEqual(tabs.rows().map((q) => q.game.id + (q.last ? '*' : '')), ['g3*'].concat(games.map((g) => g.id)));
            tabs.input({ press: true });
            tabs.input({ turn: 2 }); tabs.input({ push: 'E' }); tabs.input({ press: true });
            tabs.input({ press: true });                           // ("Start over" was for that one press)
            tabs.input({ push: 'E' }); tabs.input({ push: 'S' }); tabs.input({ press: true });   // (and is left by moving on)
            assert.deepStrictEqual(played, [['g3', false], ['g1', true], ['g1', false], ['g2', false]]);
            // as many rows as the page holds, the one in focus among them
            let r = paper();
            tabs.input({ turn: 100 });
            tabs.draw(r, 0, 0, 1, 520, {});
            assert.strictEqual(tabs.fit, 6);
            assert.deepStrictEqual(r.said.filter((s) => games.some((g) => g.title === s)), games.slice(6).map((g) => g.title));
            assert(r.said.indexOf('Play') >= 0 && r.said.indexOf('Start over') >= 0 && r.said.indexOf('Continue') < 0, r.said.join(' | '));
            tabs.input({ turn: -100 });
            r = paper();
            tabs.draw(r, 0, 0, 1, 520, { notice: 'Parked only' });
            assert.deepStrictEqual(r.said.filter((s) => games.some((g) => g.title === s)), ['Delta'].concat(games.slice(0, 5).map((g) => g.title)));
            assert(r.said.indexOf('Continue') >= 0 && r.said.indexOf('Parked only') >= 0);
            // no game played yet, no games at all
            cur = null;
            assert.strictEqual(tabs.rows().length, games.length);
            const none = new Tabs({ games: () => [], current: () => null, settings: kept([]) });
            none.open('games');
            assert.strictEqual(none.zone, 'tabs', 'the focus on a page without rows');
            r = paper();
            none.draw(r, 0, 0, 1, 520, {});
            assert(r.said.indexOf('No games yet') >= 0);
            none.input({ press: true }); none.input({ push: 'S' }); none.input({ turn: 3 });
            assert.deepStrictEqual([none.zone, none.name], ['tabs', 'settings']);
        });
        await check('tabs: up from the first row to the tabs, along them and down into a page; a gamepad\'s LB and RB go round them from anywhere', () => {
            const opened = [], drawn = [];
            const tabs = new Tabs({ games: () => games, current: () => null, settings: kept([{ key: 'a', label: 'A switch', type: 'bool', default: true }]), onTab: (n) => opened.push(n),
                drawAdd: (r, x, y, k, h) => drawn.push([x, y, k, h]) });
            tabs.open('games');
            tabs.input({ push: 'S' }); tabs.input({ push: 'N' });
            assert.deepStrictEqual([tabs.zone, tabs.at.games], ['page', 0]);
            tabs.input({ push: 'N' });
            assert.strictEqual(tabs.zone, 'tabs');
            tabs.input({ push: 'W' }); tabs.input({ turn: -3 });   // the first tab: no further
            assert.deepStrictEqual([tabs.name, opened], ['games', []]);
            tabs.input({ turn: 1 });
            tabs.input({ press: true }); tabs.input({ push: 'S' }); // (the page of a phone's code has no rows)
            assert.deepStrictEqual([tabs.name, tabs.zone], ['add', 'tabs']);
            tabs.draw(paper(), 100, 10, 2, 500, {});
            assert.deepStrictEqual(drawn, [[100, 10 + 92 * 2, 2, 408]], 'the page of a phone\'s code goes under the tabs');
            tabs.input({ push: 'E' }); tabs.input({ push: 'E' });
            tabs.input({ push: 'S' });
            assert.deepStrictEqual([tabs.name, tabs.zone], ['settings', 'page']);
            tabs.input({ tab: 1 });
            assert.deepStrictEqual([tabs.name, tabs.zone], ['games', 'page']);
            tabs.input({ tab: -1 }); tabs.input({ tab: -1 });
            assert.deepStrictEqual([tabs.name, tabs.zone], ['add', 'tabs'], 'no rows on that page: the focus is on the tabs');
            assert.deepStrictEqual(opened, ['add', 'settings', 'games', 'settings', 'add']);
            const rev = tabs.rev;
            tabs.input({ turn: 1 });
            assert(tabs.rev > rev, 'what changed is not told (rev)');
        });
        await check('tabs: a setting is a switch, or one value of several: a press goes on to the next, a push right or left as far as the last or first; hidden ones are no rows', () => {
            const s = kept([{ key: 'parked', label: 'Parked only', type: 'bool', default: true },
                { key: 'turn', label: 'Turn left', type: 'choice', default: 'start', options: [['start', 'Start'], ['select', 'Select'], ['none', 'Nothing']] },
                { key: 'secret', label: 'Not shown', type: 'bool', default: false, hidden: true }]);
            const tabs = new Tabs({ games: () => [], current: () => null, settings: s });
            tabs.open('settings');
            assert.deepStrictEqual(tabs.rows().map((q) => q.item.key), ['parked', 'turn']);
            tabs.input({ press: true });
            assert.strictEqual(s.v.parked, false);
            tabs.input({ push: 'W' });
            assert.strictEqual(s.v.parked, false, 'off, pushed left');
            tabs.input({ push: 'E' });
            assert.strictEqual(s.v.parked, true);
            tabs.input({ turn: 1 });
            tabs.input({ push: 'W' });
            assert.strictEqual(s.v.turn, 'start', 'the first value, pushed left');
            tabs.input({ push: 'E' }); tabs.input({ push: 'E' }); tabs.input({ push: 'E' });
            assert.strictEqual(s.v.turn, 'none');
            tabs.input({ press: true });
            assert.strictEqual(s.v.turn, 'start', 'a press goes round');
            tabs.input({ press: true });
            assert.strictEqual(s.v.turn, 'select');
            const r = paper();
            tabs.draw(r, 0, 0, 1, 520, {});
            assert(['Parked only', 'On', 'Turn left', 'is select'].every((t) => r.said.indexOf(t) >= 0) && r.said.indexOf('Not shown') < 0, r.said.join(' | '));
        });
    }

    /* ---------- a USB gamepad: what its packets mean (loader/pad.js), and its buttons as the SNES pad's (app/pad.js) ---------- */
    /** an Xbox pad's input report: its two button bytes and its left stick */
    const report = (b4, b5, x, y) => { const d = Buffer.alloc(18); d[0] = 0x20; d[3] = 0x0e; d[4] = b4; d[5] = b5; d.writeInt16LE(x || 0, 10); d.writeInt16LE(y || 0, 12); return d; };
    /** the same with its triggers and its right stick too */
    const whole = (b4, b5, lt, rt, x, y, rx, ry) => { const d = report(b4, b5, x, y); d.writeUInt16LE(lt, 6); d.writeUInt16LE(rt, 8); d.writeInt16LE(rx, 14); d.writeInt16LE(ry, 16); return d; };
    const XBOX_ONE_S = { vid: 0x045e, pid: 0x02ea };
    await check('gamepad: an Xbox One S pad is switched on by the kernel driver\'s four packets, counted; another make\'s pad by three', () => {
        const hexes = (list) => list.map((b) => b.toString('hex'));
        const g = new loader.pad.Gip(XBOX_ONE_S);
        assert.deepStrictEqual(hexes(g.start()), ['0520000100', '0520010f06', '0a200203000114', '062003020100']);
        assert.deepStrictEqual(hexes(g.start()), ['0520040100', '0520050f06', '0a200603000114', '062007020100'], 'asked again: the count goes on');
        assert.deepStrictEqual(hexes(new loader.pad.Gip({ vid: 0x0e6f, pid: 0x02a4 }).start()), ['0520000100', '0a200103000114', '062002020100']);
    });
    await check('gamepad: an Xbox pad\'s report is its buttons; the left stick is the D-pad too; anything else is no report', () => {
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD, F = loader.pad.PAD_FULL, far = loader.pad.STICK + 1;
        const b = (d) => g.packet(d).buttons;
        assert.strictEqual(b(report(0, 0)), 0);
        [[0x04, 0, P.START], [0x08, 0, P.SELECT], [0x10, 0, P.A], [0x20, 0, P.B], [0x40, 0, P.X], [0x80, 0, P.Y], [0, 0x01, P.UP], [0, 0x02, P.DOWN],
            [0, 0x04, P.LEFT], [0, 0x08, P.RIGHT], [0, 0x10, P.L], [0, 0x20, P.R], [0, 0x40, F.LS], [0, 0x80, F.RS], [0x01, 0xc0, F.LS | F.RS], [0x03, 0, 0]].forEach((t) => assert.strictEqual(b(report(t[0], t[1])), t[2], 'bytes ' + t[0] + ' ' + t[1]));
        assert.strictEqual(b(report(0x50, 0x09)), P.A | P.X | P.UP | P.RIGHT);
        assert.strictEqual(b(report(0, 0, far, 0)), P.RIGHT);
        assert.strictEqual(b(report(0, 0, -far, far)), P.LEFT | P.UP, 'up is the greater number');
        assert.strictEqual(b(report(0, 0, 0, -far)), P.DOWN);
        assert.strictEqual(b(report(0, 0, far - 2, 2 - far)), 0, 'a stick at rest, or not far out');
        assert.strictEqual(b(report(0x10, 0).slice(0, 8)), P.A, 'a report without the sticks');
        [Buffer.alloc(0), Buffer.from([0x20, 0, 1]), Buffer.from([0x20, 0, 1, 2, 0x10]), Buffer.from([0x03, 0x20, 1, 4, 0x80, 0, 0, 0]), null].forEach((d) => assert.deepStrictEqual(g.packet(d), {}));
        // what an Xbox One S pad sent, read through snes-usbpipe, once it was switched on: its report with nothing held and
        // the sticks where they rest (a little off the middle), and every 20 seconds a packet that is no report
        assert.strictEqual(b(Buffer.from('20000c0e0000000000004906a7027c020cf8', 'hex')), 0);
        assert.deepStrictEqual(g.packet(Buffer.from('0320430480010000', 'hex')), {});
    });
    await check('gamepad: the packets a real Xbox One S pad sent for its buttons and its left stick are read as those', () => {
        // (captured through loader/snes-usbpipe with tools/pad-try.js --raw, a button or a direction held at a time)
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD;
        const sent = {
            '2000230e8000000000004906a7027c020cf8': P.Y, '2000410e0400000000004906a7027c020cf8': P.START, '2000470e0800000000004906a7027c020cf8': P.SELECT,
            '20002f0e0002000000004906a7027c020cf8': P.DOWN, '20004f0e00100000000049062c027c020cf8': P.L, '20005e0e10080000000049062c027c020cf8': P.A | P.RIGHT,
            '2000ee0e0000000000004800004f6e051cfa': P.UP, '2000550e0000000000005f05dda86e051cfa': P.DOWN,           // the stick: up, down,
            '20009f0e0000000000009c8f79fd6e051cfa': P.LEFT, '2000d50e000000000000f84954036e051cfa': P.RIGHT,        // left, right
        };
        Object.keys(sent).forEach((hex) => assert.strictEqual(g.packet(Buffer.from(hex, 'hex')).buttons, sent[hex], hex));
        // its Xbox button, pressed and let go: each wants its own answer, and got it
        assert.strictEqual(g.packet(Buffer.from('07300102015b', 'hex')).send[0].toString('hex'), '01200109000720020000000000');
        assert.strictEqual(g.packet(Buffer.from('07300202005b', 'hex')).send[0].toString('hex'), '01200209000720020000000000');
    });
    await check('gamepad: the whole pad, for a program that wants it: both sticks, both triggers, the sticks pressed in, and the D-pad apart from the stick', () => {
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD, F = loader.pad.PAD_FULL, far = loader.pad.STICK + 1;
        Object.keys(P).forEach((k) => assert.strictEqual(F[k], P[k], k + ' is the same bit in both'));
        assert(F.LS && F.RS && F.GUIDE && F.LS !== F.RS && F.GUIDE !== F.LS && F.GUIDE !== F.RS && !Object.keys(P).some((k) => P[k] & (F.LS | F.RS | F.GUIDE)), 'the sticks pressed in and the Xbox button are bits of their own');
        let r = g.packet(whole(0x10, 0xc1, 300, 1023, -far, far, 32767, -32768));
        assert.deepStrictEqual(r.state, { buttons: P.A | P.UP | F.LS | F.RS, lt: 300, rt: 1023, lx: -far, ly: far, rx: 32767, ry: -32768 });
        assert.strictEqual(r.buttons, P.A | P.UP | P.LEFT | F.LS | F.RS, 'the SNES app\'s buttons: the left stick is the D-pad too, and the sticks pressed in are told (its way out of a game)');
        r = g.packet(whole(0, 0, 0, 0, far, -far, 0, 0));
        assert.strictEqual(r.state.buttons, 0, 'a stick held out is no button of the whole pad');
        assert.strictEqual(r.buttons, P.RIGHT | P.DOWN);
        r = g.packet(whole(0, 0, 0xffff, 2000, 0, 0, 0, 0));
        assert(r.state.lt === loader.pad.TRIGGER_MAX && r.state.rt === loader.pad.TRIGGER_MAX && loader.pad.TRIGGER_MAX === 1023, 'a trigger is never more than all the way');
        // a report cut short tells what it has
        assert.deepStrictEqual(g.packet(whole(0x20, 0, 5, 6, 7, 8, 9, 10).slice(0, 8)).state, { buttons: P.B, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
        assert.deepStrictEqual(g.packet(whole(0x20, 0, 5, 6, 7, 8, 9, 10).slice(0, 14)).state, { buttons: P.B, lt: 5, rt: 6, lx: 7, ly: 8, rx: 0, ry: 0 });
        // what a real Xbox One S pad sent (tools/pad-try.js --raw): its right trigger pulled all the way; its right
        // stick full right, and far out another way; its left stick at each of its four ends; A with the D-pad's
        // right. Its left trigger and its sticks pressed in were not among what it sent.
        const sent = {
            '20007d0e00000000ff03610c46020f05d9f8': { buttons: 0, lt: 0, rt: 1023, lx: 3169, ly: 582, rx: 1295, ry: -1831 },
            '2000400e000000000000610c4602ff7fca03': { buttons: 0, lt: 0, rt: 0, lx: 3169, ly: 582, rx: 32767, ry: 970 },
            '2000620e000000000000610c4602c16a5fa1': { buttons: 0, lt: 0, rt: 0, lx: 3169, ly: 582, rx: 27329, ry: -24225 },
            '2000fa0e000000000000ff7fdbf86e051cfa': { buttons: 0, lt: 0, rt: 0, lx: 32767, ly: -1829, rx: 1390, ry: -1508 },
            '2000a00e00000000000000802cfd6e051cfa': { buttons: 0, lt: 0, rt: 0, lx: -32768, ly: -724, rx: 1390, ry: -1508 },
            '2000f10e00000000000014fdff7f6e051cfa': { buttons: 0, lt: 0, rt: 0, lx: -748, ly: 32767, rx: 1390, ry: -1508 },
            '2000570e000000000000820000806e051cfa': { buttons: 0, lt: 0, rt: 0, lx: 130, ly: -32768, rx: 1390, ry: -1508 },
            '20005e0e10080000000049062c027c020cf8': { buttons: P.A | P.RIGHT, lt: 0, rt: 0, lx: 1609, ly: 556, rx: 636, ry: -2036 },
        };
        Object.keys(sent).forEach((hex) => assert.deepStrictEqual(g.packet(Buffer.from(hex, 'hex')).state, sent[hex], hex));
    });
    await check('gamepad: the Xbox button\'s report is acknowledged; a pad that says hello later is switched on again, its buttons let go', () => {
        let t = 0;
        const g = new loader.pad.Gip(XBOX_ONE_S, () => t);
        g.start();
        // (held or not is bit 0 of the fifth byte, as the kernel's driver has it: a button of its own beside the report's)
        const F = loader.pad.PAD_FULL;
        const down = g.packet(Buffer.from('07302a02015b', 'hex'));
        assert.deepStrictEqual(down.send.map((b) => b.toString('hex')), ['01202a09000720020000000000']);
        assert.strictEqual(down.buttons, F.GUIDE, 'the Xbox button held');
        assert.deepStrictEqual(g.packet(Buffer.from('07302b02015b', 'hex')).buttons, undefined, 'said again: nothing new');
        assert.strictEqual(g.packet(report(0x10, 0)).buttons, F.A | F.GUIDE, 'a report while it is held');
        assert.deepStrictEqual(g.packet(Buffer.from('07202a02005b', 'hex')), { buttons: F.A }, 'let go, and no acknowledgement asked for: none sent');
        assert.strictEqual(g.packet(report(0, 0)).buttons, 0);
        const hello = Buffer.from('02200a1c7eed8be0', 'hex');
        assert.deepStrictEqual(g.packet(hello), {}, 'hello at the start: it is being switched on');
        t += 5000;
        const r = g.packet(hello);
        assert(r.buttons === 0 && r.send.length === 4 && r.send[0].toString('hex') === '0520040100', JSON.stringify(r));
        assert.deepStrictEqual(r.state, { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 }, 'and its sticks and triggers');
        assert.deepStrictEqual(g.packet(hello), {}, 'and not again at once');
    });
    await check('gamepad: found on the USB bus as the head unit lists an Xbox One S pad; one a kernel driver has, or another device, is not', () => {
        // (as read on a head unit with the pad plugged in: probe-controller.txt)
        const iface = (cls, sub, proto, n) => ({ bInterfaceClass: cls, bInterfaceSubClass: sub, bInterfaceProtocol: proto, bInterfaceNumber: n });
        const tree = {
            usb1: { busnum: '1', devnum: '1', idVendor: '1d6b', idProduct: '0002', product: 'xHCI Host Controller' },
            '1-0:1.0': Object.assign(iface('09', '00', '00', '00'), { driver: '' }),
            '1-3': { busnum: '1', devnum: '2', idVendor: '0424', idProduct: '4502' },
            '1-3:1.0': Object.assign(iface('09', '00', '01', '00'), { driver: '' }),
            '1-3.1': { busnum: '1', devnum: '4', idVendor: '045e', idProduct: '02ea', product: 'Controller', manufacturer: 'Microsoft' },
            '1-3.1:1.0': Object.assign(iface('ff', '47', 'd0', '00'), { 'ep_02/bEndpointAddress': '02', 'ep_02/bmAttributes': '03', 'ep_02/wMaxPacketSize': '0040', 'ep_82/bEndpointAddress': '82', 'ep_82/bmAttributes': '03', 'ep_82/wMaxPacketSize': '0040' }),
            '1-3.1:1.1': iface('ff', '47', 'd0', '01'),
            '1-3.1:1.2': iface('ff', '47', 'd0', '02'),
            '1-3.3': { busnum: '1', devnum: '3', idVendor: '0424', idProduct: '2530', product: 'Bridge device' },
            '1-3.3:1.0': iface('ff', '00', '00', '00'),
        };
        const SYS = '/sys/bus/usb/devices';
        const entry = (file) => { const rel = file.slice(SYS.length + 1), i = rel.indexOf('/'); return [tree[i < 0 ? rel : rel.slice(0, i)], i < 0 ? null : rel.slice(i + 1)]; };
        const io = {
            list: (dir) => { if (dir === SYS) return Object.keys(tree); const e = entry(dir)[0]; return e ? Object.keys(e).map((k) => k.split('/')[0]).filter((k, i, all) => all.indexOf(k) === i) : []; },
            read: (file) => { const e = entry(file); return e[0] && e[0][e[1]] !== undefined ? e[0][e[1]] : null; },
            has: (file) => { const e = entry(file); return !!e[0] && e[0][e[1]] !== undefined; },
        };
        assert.deepStrictEqual(loader.pad.find({ io }), [{ kind: 'gip', node: '/dev/bus/usb/001/004', iface: 0, epIn: 0x82, epOut: 0x02, packet: 64, vid: 0x045e, pid: 0x02ea, name: 'Controller' }]);
        tree['1-3.1:1.0'].driver = '';                         // (a PC: its kernel's own driver has the pad)
        assert.deepStrictEqual(loader.pad.find({ io }), []);
        delete tree['1-3.1:1.0'].driver;
        delete tree['1-3.1:1.0']['ep_02/bEndpointAddress'];
        assert.deepStrictEqual(loader.pad.find({ io }), [], 'a pad that takes no packets cannot be switched on');
        assert.deepStrictEqual(loader.pad.find({ sys: path.join(os.tmpdir(), 'snes-test-no-such-folder') }), [], 'no USB bus to look at (a PC that is not Linux)');
    });
    await check('gamepad: the app knows the loader\'s buttons, and makes the SNES pad of an Xbox pad\'s', () => {
        assert.deepStrictEqual(PAD, loader.pad.PAD_FULL);
        // by where a button is: the Xbox pad's A (at the bottom) is the SNES pad's B, its B (on the right) the A,
        // its X (on the left) the Y, its Y (at the top) the X
        assert.strictEqual(toSnes(PAD.A), BTN.B);
        assert.strictEqual(toSnes(PAD.B), BTN.A);
        assert.strictEqual(toSnes(PAD.X), BTN.Y);
        assert.strictEqual(toSnes(PAD.Y), BTN.X);
        assert.strictEqual(toSnes(PAD.L | PAD.R), BTN.L | BTN.R, 'the shoulder buttons are the game\'s');
        assert.strictEqual(toSnes(PAD.UP | PAD.A), BTN.UP | BTN.B);
        assert.strictEqual(toSnes(PAD.Y | PAD.LEFT | PAD.DOWN), BTN.X | BTN.LEFT | BTN.DOWN);
        assert.strictEqual(toSnes(PAD.START | PAD.SELECT | PAD.RIGHT), BTN.START | BTN.SELECT | BTN.RIGHT);
        // by its letter, for whoever wants that
        assert.strictEqual(toSnes(PAD.A, true), BTN.A);
        assert.strictEqual(toSnes(PAD.B | PAD.X | PAD.Y, true), BTN.B | BTN.X | BTN.Y);
        assert.strictEqual(toSnes(PAD.L | PAD.UP, true), BTN.L | BTN.UP);
        // either way every one of the SNES pad's twelve buttons has a button of the gamepad's, and only one
        const twelve = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'START', 'SELECT', 'L', 'R'];
        [false, true].forEach((letters) => {
            const got = twelve.map((k) => toSnes(PAD[k], letters));
            assert.strictEqual(got.reduce((a, m) => a | m, 0), 0xfff, 'not all twelve');
            got.forEach((m) => assert(m && !(m & (m - 1)), 'a button that is two'));
        });
        // the sticks pressed in and the Xbox button are no button of an SNES pad: both sticks together, or the Xbox
        // button, are the way out of a game
        assert.strictEqual(toSnes(PAD.LS | PAD.RS | PAD.GUIDE), 0);
        assert(wantsOut(PAD.LS | PAD.RS) && wantsOut(PAD.GUIDE) && wantsOut(PAD.LS | PAD.RS | PAD.A), 'no way out');
        assert(!wantsOut(PAD.LS) && !wantsOut(PAD.RS) && !wantsOut(PAD.L | PAD.R) && !wantsOut(PAD.START | PAD.SELECT) && !wantsOut(0), 'out by a button of the game\'s');
    });

    /* ---------- games and saves ---------- */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snes-test-'));
    const other = Buffer.concat([rom, Buffer.from('another')]);
    await check('library: games from the app\'s packs and from the data folder, by title; a later place wins', () => {
        writePack(path.join(tmp, 'games.pack'), { 'Snake.sfc': rom, 'alpha_run.smc': rom });
        writePack(path.join(tmp, 'roms.pack'), { 'Zebra Quest (USA).sfc': rom, 'alpha_run.smc': other, 'README.txt': Buffer.from('x'), 'Old Game.nes': rom });
        fs.mkdirSync(path.join(tmp, 'roms'));
        fs.writeFileSync(path.join(tmp, 'roms', 'Middle Game [!].SMC'), rom);
        fs.writeFileSync(path.join(tmp, 'roms', 'SNAKE.SFC'), other);
        fs.writeFileSync(path.join(tmp, 'roms', 'notes.txt'), 'x');
        const lib = new Library({ packs: [path.join(tmp, 'games.pack'), path.join(tmp, 'roms.pack'), path.join(tmp, 'no.pack')], dirs: [path.join(tmp, 'roms'), path.join(tmp, 'none')], dataDir: tmp, log });
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['alpha run', 'Middle Game', 'SNAKE', 'Zebra Quest']);
        assert.deepStrictEqual(lib.games.map((g) => lib.read(g).equals(other)), [true, false, true, false], 'the same name in a later pack or a folder was not the one read');
        assert(lib.read(lib.games[1]).equals(rom) && lib.read(lib.games[3]).equals(rom));
        assert.strictEqual(titleOf('Some Game (Europe) (Rev 1) [b2].smc'), 'Some Game');
    });
    await check('library: games in a folder "snes" on a USB stick are there while the stick is', () => {
        const media = path.join(tmp, 'media'), mk = (p) => { p.split('/').reduce((d, part) => { const n = path.join(d, part); if (!fs.existsSync(n)) fs.mkdirSync(n); return n; }, media); };
        fs.mkdirSync(media);
        mk('STICK/snes'); mk('MUSIC/albums'); mk('OTHER/SNES'); mk('OTHER/nes2');
        fs.writeFileSync(path.join(media, 'STICK', 'snes', 'Stick Game.sfc'), rom);
        fs.writeFileSync(path.join(media, 'OTHER', 'SNES', 'Other Game.smc'), rom);
        fs.writeFileSync(path.join(media, 'MUSIC', 'snes'), 'a file, not a folder');
        const names = ['snes', 'SNES', 'Snes'], roots = [media, path.join(tmp, 'no-such-root')];
        const found = usbFolders(roots, names);
        // (in whatever letters the folder is named: a file system that does not tell them apart finds it by the first)
        assert.deepStrictEqual(found.dirs.map((d) => path.relative(media, d).replace(/\\/g, '/').toLowerCase()).sort(), ['other/snes', 'stick/snes']);
        assert.deepStrictEqual(found.errors, [], 'a stick without the folder, or no stick at all, is no error');
        const lib = new Library({ packs: [], dirs: [], more: () => usbFolders(roots, names).dirs, dataDir: tmp, log });
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Other Game', 'Stick Game']);
        assert(lib.read(lib.games[1]).equals(rom));
        fs.unlinkSync(path.join(media, 'STICK', 'snes', 'Stick Game.sfc'));
        fs.rmdirSync(path.join(media, 'STICK', 'snes'));
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Other Game'], 'the stick is out: its games are still listed');
    });
    await check('library: state, battery memory and the game played last are kept per game', () => {
        const lib = new Library({ packs: [path.join(tmp, 'roms.pack')], dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        const a = lib.scan()[0], b = lib.games[1];
        assert(lib.state(a) === null && lib.sram(a) === null && lib.last() === null);
        assert(lib.setState(a, Buffer.from('state-a')) && lib.setSram(b, Buffer.from('sram-b')));
        lib.setLast(b);
        const again = new Library({ packs: [path.join(tmp, 'roms.pack')], dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        again.scan();
        assert.strictEqual(String(again.state(again.byId(a.id))), 'state-a');
        assert.strictEqual(String(again.sram(again.byId(b.id))), 'sram-b');
        assert(again.state(again.byId(b.id)) === null);
        assert.strictEqual(again.last().id, b.id);
        // a state is one core's: the other core's (setting "Sound chip") is kept beside it and never handed over
        assert(again.setState(again.byId(a.id), Buffer.from('state-a-plus'), 'plus'));
        assert.strictEqual(String(again.state(again.byId(a.id))), 'state-a');
        assert.strictEqual(String(again.state(again.byId(a.id), 'plus')), 'state-a-plus');
        assert(again.state(again.byId(b.id), 'plus') === null);
        assert(again.setState(again.byId(b.id), Buffer.from('state-b')));
        // "Start over" drops the game's states, whichever core made them, and no other game's
        again.dropState(again.byId(a.id));
        assert(again.state(again.byId(a.id)) === null && again.state(again.byId(a.id), 'plus') === null);
        assert.strictEqual(String(again.state(again.byId(b.id))), 'state-b');
        assert.strictEqual(String(again.sram(again.byId(b.id))), 'sram-b', 'the battery memory went with a state');
        assert(!fs.readdirSync(path.join(tmp, 'saves')).some((f) => /\.tmp$/.test(f)), 'a temporary file was left');
    });

    /* ---------- the game that comes with the app (app/games/, built from games/ by games/build.js) ---------- */
    const gamesDir = path.join(ROOT, 'app/games');
    const bundled = (name) => fs.readFileSync(path.join(gamesDir, name));
    await check('games: app/games/ holds the one game written for the app, and nothing else to play', () => {
        assert.deepStrictEqual(fs.readdirSync(gamesDir).filter((f) => /\.(sfc|smc)$/i.test(f)).sort(), BUNDLED);
        BUNDLED.forEach((f) => { const b = fs.readFileSync(path.join(gamesDir, f)), i = romInfo(b); assert(i && i.mapping === 'LoROM' && i.title === 'SNES IDRIVE PAD TEST' && i.chip === 0 && b.length === 131072, f + ': ' + JSON.stringify(i)); });
        // its header's checksum is right (games/build.js signs it)
        const b = fs.readFileSync(path.join(gamesDir, BUNDLED[0]));
        let sum = 0;
        for (let i = 0; i < b.length; i++) sum = (sum + b[i]) & 0xffff;
        assert.strictEqual(b[0x7fde] | (b[0x7fdf] << 8), sum, 'the checksum in the header');
    });
    // where Pad Test shows a button: its light's column and row on the 32 x 28 map (games/src/pad_test.s)
    const SPOT = { UP: [9, 7], DOWN: [9, 9], LEFT: [9, 11], RIGHT: [9, 13], SELECT: [9, 15], START: [9, 17], B: [25, 7], A: [25, 9], Y: [25, 11], X: [25, 13], L: [25, 15], R: [25, 17] };
    const isRed = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    await check('games: Pad Test lights each of the twelve buttons while it is held and no other, counts its presses, and its clock runs', () => {
        const g = new Snes({ wasm: WASM, log });
        g.mod = snes.mod;
        assert(g.load(fs.readFileSync(path.join(gamesDir, 'Pad_Test.sfc'))), 'Pad Test did not load');
        const start = shot(g, 40);
        assert(start.w === 256 && start.h === 224, 'picture ' + start.w + 'x' + start.h);
        const zero = tiles(start, 12, 7, 1);                   // a "0" of a count
        Object.keys(SPOT).forEach((k) => assert(!isRed(middle(start, SPOT[k][0], SPOT[k][1])), k + ' is lit with nothing held'));
        // the four corner marks: the whole picture is the game's
        [[0, 0], [31, 0], [0, 27], [31, 27]].forEach((c) => assert(!tiles(start, c[0], c[1], 1).equals(tiles(start, 5, 0, 1)), 'no mark in the corner ' + c));
        let one = null;
        Object.keys(SPOT).forEach((k) => {
            const held = shot(g, 4, BTN[k]);
            Object.keys(SPOT).forEach((o) => assert.strictEqual(isRed(middle(held, SPOT[o][0], SPOT[o][1])), o === k, 'with ' + k + ' held, ' + o + (o === k ? ' is not lit' : ' is lit')));
            const after = shot(g, 4, 0), at = SPOT[k];
            assert(!isRed(middle(after, at[0], at[1])), k + ' stays lit');
            const digits = tiles(after, at[0] + 3, at[1], 3);
            assert(digits.slice(0, 0).length === 0 && tiles(after, at[0] + 3, at[1], 1).equals(zero) && tiles(after, at[0] + 4, at[1], 1).equals(zero), k + ': its count is not 00x');
            const ones = tiles(after, at[0] + 5, at[1], 1);
            assert(!ones.equals(zero), k + ' was not counted');
            if (one) assert(ones.equals(one), k + ': its count is not 1'); else one = ones;
        });
        // a second press of A is a 2, a held button counts once
        shot(g, 4, BTN.A);
        const twice = shot(g, 30, 0), two = tiles(twice, 30, 9, 1);
        assert(!two.equals(one) && !two.equals(zero), 'A pressed twice is not 2');
        assert(tiles(shot(g, 40, BTN.A), 30, 9, 1).equals(tiles(shot(g, 4, 0), 30, 9, 1)), 'a held button counts on');
        // the clock: TIME mm:ss.t at column 15 of row 20; after 600 more frames ten seconds more
        const t0 = shot(g, 1), secs0 = tiles(t0, 18, 20, 2);
        const t1 = shot(g, 600), secs1 = tiles(t1, 18, 20, 2);
        assert(!secs0.equals(secs1), 'the clock stands');
        assert(tiles(t0, 19, 20, 1).equals(tiles(t1, 19, 20, 1)) && !tiles(t0, 18, 20, 1).equals(tiles(t1, 18, 20, 1)), '600 frames are not ten seconds on its clock');
        // the ball: a sprite in row 23, a pixel a frame
        const xs = [];
        for (let i = 0; i < 3; i++) { const f = shot(g, 1); for (let x = 0; x < 256; x++) { const p = ((23 * 8 + 4) * f.w + x) * 4; if (f.px[p] > 200 && f.px[p + 1] < 60) { xs.push(x); break; } } }
        assert(xs.length === 3 && Math.abs(xs[1] - xs[0]) === 1 && xs[2] - xs[1] === xs[1] - xs[0], 'the ball does not go a pixel a frame: ' + xs);
    });
    await check('games: Pad Test beeps as each second begins on its clock (1000 Hz, a tenth of a second), and is quiet between', () => {
        const g = new Snes({ wasm: WASM, log });
        g.mod = snes.mod;
        assert(g.load(fs.readFileSync(path.join(gamesDir, 'Pad_Test.sfc'))));
        const loud = [];
        let beep = [];
        for (let i = 0; i < 250; i++) {
            g.run();
            const a = g.audio(), h = a ? heard(a.bytes) : { peak: 0 };
            loud.push(h.peak > 1500);
            if (i >= 122 && i <= 125 && a) beep.push(Buffer.from(a.bytes));
        }
        const starts = [];
        loud.forEach((on, i) => { if (on && !loud[i - 1]) starts.push(i); });
        assert.strictEqual(starts.length, 4, 'beeps began in frames ' + starts);
        starts.forEach((s, i) => assert(Math.abs(s - 60 * (i + 1)) <= 3, 'a beep began in frame ' + s));
        assert(starts[1] - starts[0] === 60 && starts[2] - starts[1] === 60, 'the beeps are not 60 frames apart: ' + starts);
        const len = loud.slice(starts[0], starts[0] + 20).filter(Boolean).length;
        assert(len >= 5 && len <= 9, 'a beep lasts ' + len + ' frames');
        assert(!loud.slice(starts[0] + 15, starts[1] - 2).some(Boolean), 'not quiet between two beeps');
        const h = heard(Buffer.concat(beep)), seconds = h.frames / 32040;
        assert(Math.abs(h.cycles / seconds - 1000) < 30, 'the beep is ' + (h.cycles / seconds).toFixed(0) + ' Hz');
    });

    /* ---------- games from a phone: the code on the screen, the loader, the page ---------- */
    await check('phone: a QR code is, module for module, what a reference encoder makes of the same text', () => {
        // (from python-qrcode: byte mode, level L, the mask named; rows from the top, 8 modules a byte)
        const known = [
            ['A', 1, 0, 'fe5bfc13906eb6bb74a5dba2aec10507faafe01b00eff6258411979a22b1844368aa804aabfaddf05fb8bad76dd311aeb22305046feeab80'],
            ['http://172.16.222.97:8493/0123456789abcdef0123', 3, 6, 'fe9e4bfc1334d06e8becbb741ae5dba521aec1167107faaaafe016c100da726a0dea5ce5bacde82828f6b3143d9360f063b56d8d7f61bb1a6125ca6db505c1ceafbfe55fc38bf945cf6036ff006dc463f8f5eb10410910ba933f85d6e88b6e895c270517665fed7aec00'],
            ['m'.repeat(106), 5, 1, 'fea22223fc155555506e955554bb74eeeee5dbaa22222ec155555507faaaaaafe015555500e6e8888f9e46eeeedb7da555542a5bd5555bafb08888b4509eeeedb6cdd55542a3015555ba03e8888b4689eeeedb418d55542a8355555ba5f08888b4746eeeedb69a555542ba215555ba7ac8888b4222eeeedb7e8d55542a52d5555bacf48888fc006eeee477f8d5552ab05d555719ba48889fd5d2eeeea76ead55512b0515555e8fe88888a480'],
        ];
        known.forEach((k) => {
            const q = qr(k[0], { mask: k[2] });
            assert(q.version === k[1] && q.size === 17 + 4 * k[1] && q.modules.length === q.size * q.size, 'version ' + q.version + ' for ' + k[0].slice(0, 20));
            const bytes = Buffer.alloc(Math.ceil(q.modules.length / 8));
            q.modules.forEach((d, i) => { if (d) bytes[i >> 3] |= 0x80 >> (i & 7); });
            assert.strictEqual(bytes.toString('hex'), k[3], 'the code of ' + k[0].slice(0, 30));
        });
        const best = qr('http://172.16.222.97:8494/0123456789abcdef0123/');
        assert(best.version === 3 && best.mask >= 0 && best.mask < 8, 'the page\'s address is a version 3 code');
        assert.throws(() => qr('n'.repeat(107)), /too long/);
    });
    const game = bundled('Pad_Test.sfc');
    const spec0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/app.json'), 'utf8'));
    await check('loader: a name is made safe; what is no SNES game is refused', () => {
        const names = { 'Super Game (USA).sfc': 'Super Game (USA).sfc', '../../etc/passwd': null, '../../evil.sfc': 'evil.sfc', 'C:\\roms\\Zelda.SFC': 'Zelda.sfc', '.hidden.sfc': 'hidden.sfc',
            '   .sfc': null, 'game.zip': null, 'game.nes': null, 'Copied Game.SMC': 'Copied Game.smc', 'Other.Smc': 'Other.smc', 'a\u0000b\n.sfc': 'a_b_.sfc', '': null, 'G\u00e4nse & Co [!].sfc': 'G_nse & Co [!].sfc' };
        Object.keys(names).forEach((n) => assert.strictEqual(loader.games.safeName(n), names[n], JSON.stringify(n)));
        assert(loader.games.safeName('x'.repeat(300) + '.sfc').length <= 80);
        assert.strictEqual(loader.games.refuse(game), null);
        assert(/too small/.test(loader.games.refuse(game.slice(0, 5000))) && /not an SNES game/.test(loader.games.refuse(Buffer.alloc(40000, 7))));
        assert(/bigger/.test(loader.games.refuse(Buffer.concat([game.slice(0, 16), Buffer.alloc(loader.games.MAX_GAME)]))));
    });
    await check('loader: a game goes into the games folder whole, under its safe name, and out again', () => {
        const dir = path.join(tmp, 'loader-games');
        const saved = loader.games.save(dir, '../My Game.SFC', game);
        assert.deepStrictEqual(saved, { name: 'My Game.sfc', size: game.length, replaced: false });
        assert(fs.readFileSync(path.join(dir, 'My Game.sfc')).equals(game));
        assert.strictEqual(loader.games.save(dir, 'my game.sfc', game).replaced, true, 'the same name in other letters is the same game');
        assert.deepStrictEqual(fs.readdirSync(dir), ['my game.sfc'], 'one file, and none half written');
        assert.throws(() => loader.games.save(dir, 'notes.txt', game), (e) => e.refused === true);
        assert.throws(() => loader.games.save(dir, 'broken.sfc', Buffer.alloc(40000)), (e) => e.refused === true && /not an SNES game/.test(e.message));
        if (process.platform !== 'win32') {
            // a link someone left under the game's name is replaced, never written through
            const outside = path.join(tmp, 'outside.txt');
            fs.writeFileSync(outside, 'untouched');
            fs.symlinkSync(outside, path.join(dir, 'Trap.sfc'));
            loader.games.save(dir, 'Trap.sfc', game);
            assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'untouched');
            assert(fs.lstatSync(path.join(dir, 'Trap.sfc')).isFile());
        }
        assert.deepStrictEqual(loader.games.list(dir).map((g) => g.name).filter((n) => n !== 'Trap.sfc'), ['my game.sfc']);
        assert(loader.games.remove(dir, 'MY GAME.sfc') && !loader.games.remove(dir, 'my game.sfc') && !loader.games.remove(dir, '../outside.txt'));
    });
    await check('loader: the app\'s user is the number in its folder\'s name, whoever owns the folder; no games folder yet is no games, one that cannot be read is an error', () => {
        const oap = path.join(tmp, 'oap-names'), root = path.join(oap, 'oap_12244');
        [oap, root, path.join(root, 'source'), path.join(root, 'data'), path.join(oap, 'oap_12201'), path.join(oap, 'notes')].forEach((d) => fs.mkdirSync(d));
        assert.strictEqual(loader.games.findApp(oap), null, 'no app yet');
        fs.writeFileSync(path.join(root, 'source', 'package.json'), JSON.stringify({ name: 'clucraft_snes' }));
        const app = loader.games.findApp(oap);
        assert.deepStrictEqual([app.root, app.data, app.games, app.uid], [root, path.join(root, 'data'), path.join(root, 'data', 'roms'), 12244]);
        assert.deepStrictEqual(loader.games.list(app.games), []);
        assert.strictEqual(loader.games.unusable(app.games), null, 'no folder yet, where one can be made');
        assert.strictEqual(loader.games.unusable(path.join(app.games, 'deeper', 'still')), 'ENOENT');
        if (process.platform !== 'win32' && process.getuid() !== 0) {
            fs.mkdirSync(app.games);
            fs.chmodSync(app.games, 0);
            try {
                assert.throws(() => loader.games.list(app.games), (e) => e.code === 'EACCES');
                assert.strictEqual(loader.games.unusable(app.games), 'EACCES');
            } finally { fs.chmodSync(app.games, 0o755); }
        }
        // the page says so to the phone, and to the service for the car's screen, in place of "no games"
        const notAFolder = path.join(root, 'source', 'package.json'), told = [];
        const page = loader.page.createPage({ token: 'a'.repeat(20), port: 1, dir: notAFolder, tell: (m) => told.push(m) });
        const ask = (method, url, body) => new Promise((resolve) => {
            const req = new (require('events'))();
            Object.assign(req, { method, url, headers: {}, destroy() {} });
            page.handle(req, { writeHead(code) { this.code = code; }, end(data) { resolve({ status: this.code, body: JSON.parse(String(data)) }); } });
            if (body) { req.emit('data', body); req.emit('end'); }
        });
        const loud = console.error;
        console.error = () => {};           // (the page tells its journal too)
        return ask('GET', '/' + 'a'.repeat(20) + '/games').then((r) => {
            assert.deepStrictEqual(r, { status: 500, body: { ok: false, error: 'The car cannot read its games folder (ENOTDIR)' } });
            return ask('POST', '/' + 'a'.repeat(20) + '/games?name=A.sfc', game);
        }).then((r) => {
            console.error = loud;
            assert.deepStrictEqual(r, { status: 500, body: { ok: false, error: 'the car could not save it (ENOTDIR)' } });
            assert.deepStrictEqual(told, [{ event: 'refused', name: 'A.sfc', why: 'the car could not save it (ENOTDIR)' }]);
        }, (e) => { console.error = loud; throw e; });
    });
    await check('loader: the page is on the car\'s own Wi-Fi; on a Wi-Fi the car has joined only when the app asks, and that one is first then; never on the car\'s other networks', () => {
        const v4 = (address, internal) => [{ address, family: 'IPv4', internal: !!internal }, { address: 'fe80::1', family: 'IPv6', internal: !!internal }];
        // (as a head unit had them, on its owner's home Wi-Fi: its /sys/class/net and /proc/net/fib_trie)
        const unit = { lo: v4('127.0.0.1', true), 'p2p-wlan0-0': [], socnet0: v4('160.48.199.99'), vlan65: v4('160.48.199.119'), vlan73: v4('160.48.199.161'), wlan0: v4('192.168.1.50'), wlan_bridge: v4('172.16.222.97') };
        const pick = (only, joined, all) => loader.service.carWifi(only, joined, all).map((i) => i.kind + ' ' + i.name + ' ' + i.address);
        const but = (name) => { const o = Object.assign({}, unit); delete o[name]; return o; };
        assert.deepStrictEqual(pick(null, false, unit), ['car wlan_bridge 172.16.222.97']);
        assert.deepStrictEqual(pick(null, true, unit), ['joined wlan0 192.168.1.50', 'car wlan_bridge 172.16.222.97']);
        // it has joined nothing, or has no address there yet
        assert.deepStrictEqual(pick(null, true, but('wlan0')), ['car wlan_bridge 172.16.222.97']);
        assert.deepStrictEqual(pick(null, true, Object.assign({}, unit, { wlan0: v4('169.254.10.7') })), ['car wlan_bridge 172.16.222.97']);
        // it has no Wi-Fi of its own (no hotspot, no CarPlay): the one it joined, when asked, and nothing else
        assert.deepStrictEqual(pick(null, true, but('wlan_bridge')), ['joined wlan0 192.168.1.50']);
        assert.deepStrictEqual(pick(null, false, but('wlan_bridge')), []);
        // an access point of its own under another name, a second Wi-Fi joined, a cable
        assert.deepStrictEqual(pick(null, true, { uap0: v4('192.168.50.1'), wlan1: v4('10.0.0.12'), eth0: v4('10.1.1.1') }), ['joined wlan1 10.0.0.12', 'car uap0 192.168.50.1']);
        // a test's own choice, and the emulator's
        assert.deepStrictEqual(pick(['lo'], false, unit), ['car lo 127.0.0.1']);
        assert.deepStrictEqual(pick(['*'], true, { lo: v4('127.0.0.1', true), eth0: v4('192.168.1.20') }), ['joined eth0 192.168.1.20', 'joined lo 127.0.0.1']);
    });
    await check('loader: the firewall listing is read as the head unit prints it; a rule names one interface, the port and our mark', () => {
        const listing = ['table ip filter { # handle 1', '\tchain INPUT { # handle 1', '\t\ttype filter hook input priority filter; policy drop;',
            '\t\tiifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web" # handle 77',
            '\t\tiifname "wlan_bridge" tcp dport 8494 accept comment "clucraft-snes-loader" # handle 91', '\t\tct state established,related accept # handle 5', '\t}',
            '\tchain OUTPUT { # handle 2', '\t\ttype filter hook output priority filter; policy drop;', '\t}', '\tchain helper { # handle 3', '\t\ttcp dport 22 accept # handle 12', '\t}', '}',
            'table inet mgu_uplink { # handle 4', '\tchain in { # handle 1', '\t\ttype filter hook input priority 10; policy accept;', '\t}', '}'].join('\n');
        assert.deepStrictEqual(loader.nft.chains(listing), [
            { family: 'ip', table: 'filter', chain: 'INPUT', hook: 'input', mine: ['91'] }, { family: 'ip', table: 'filter', chain: 'OUTPUT', hook: 'output', mine: [] },
            { family: 'ip', table: 'filter', chain: 'helper', hook: null, mine: [] }, { family: 'inet', table: 'mgu_uplink', chain: 'in', hook: 'input', mine: [] }]);
        assert.deepStrictEqual(loader.nft.rulesFor('input', ['wlan_bridge', 'x"; drop'], 8494).map((r) => r.join(' ')), ['iifname "wlan_bridge" tcp dport 8494 accept comment "clucraft-snes-loader"']);
        assert.deepStrictEqual(loader.nft.rulesFor('output', ['uap0'], 8494).map((r) => r.join(' ')), ['oifname "uap0" tcp sport 8494 accept comment "clucraft-snes-loader"']);
        assert.deepStrictEqual(loader.nft.rulesFor('forward', ['uap0'], 8494), []);
        assert.strictEqual(loader.nft.rulesFor('input', ['uap0', 'wlan_bridge', 'uap0'], 8494).length, 2, 'an interface with two addresses is named twice: one rule for it');
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); } throw new Error('never: ' + what); };
    if (process.platform === 'win32') console.log('skip loader: the service with a firewall and the app (a head unit runs Linux: these need its kind of sockets and a shell)');
    else {
        // the head unit in small: an app's folder as MainApp lays it out, and a firewall that drops what no rule accepts
        const oap = path.join(tmp, 'oap'), appRoot = path.join(oap, 'oap_12345'), state = path.join(tmp, 'nft.json'), nftProgram = path.join(tmp, 'nft');
        [oap, appRoot, path.join(appRoot, 'source'), path.join(appRoot, 'data'), path.join(oap, 'oap_12201'), path.join(oap, 'oap_12201', 'source')].forEach((d) => fs.mkdirSync(d));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'source', 'package.json'), JSON.stringify({ name: 'mainapp' }));
        const ruleset = () => JSON.parse(fs.readFileSync(state, 'utf8'));
        const rules = (family, table, chain) => ruleset().tables.find((t) => t.family === family && t.name === table).chains.find((c) => c.name === chain).rules.map((r) => r.text);
        const fresh = () => fs.writeFileSync(state, JSON.stringify({ next: 100, tables: [
            { family: 'ip', name: 'filter', chains: [{ name: 'INPUT', hook: 'input', policy: 'drop', rules: [{ text: 'ct state established,related accept', handle: 5 }] }, { name: 'OUTPUT', hook: 'output', policy: 'drop', rules: [] }, { name: 'side', rules: [] }] },
            { family: 'inet', name: 'mgu_uplink', chains: [{ name: 'in', hook: 'input', rules: [{ text: 'iifname "vethuplink" drop', handle: 9 }] }, { name: 'fwd', hook: 'forward', rules: [] }] },
            { family: 'ip6', name: 'filter', chains: [{ name: 'INPUT', hook: 'input', rules: [] }] }] }));
        fs.writeFileSync(nftProgram, '#!/bin/sh\nFAKE_NFT_STATE="' + state + '" exec "' + process.execPath + '" "' + path.join(ROOT, 'test', 'fake-nft.js') + '" "$@"\n');
        fs.chmodSync(nftProgram, 0o755);
        const mark = 'comment "clucraft-snes-loader"';
        await check('loader: the port is opened in every chain packets come in and go out through, once, and closed without a trace', () => {
            fresh();
            let r = loader.nft.open(['wlan_bridge'], 8494, { program: nftProgram });
            assert(r.changed && r.chains === 3 && !r.errors.length, JSON.stringify(r));
            assert.deepStrictEqual(rules('ip', 'filter', 'INPUT'), ['iifname "wlan_bridge" tcp dport 8494 accept ' + mark, 'ct state established,related accept'], 'our rule is first: before what drops');
            assert.deepStrictEqual(rules('ip', 'filter', 'OUTPUT'), ['oifname "wlan_bridge" tcp sport 8494 accept ' + mark]);
            assert.deepStrictEqual(rules('inet', 'mgu_uplink', 'in'), ['iifname "wlan_bridge" tcp dport 8494 accept ' + mark, 'iifname "vethuplink" drop']);
            assert(!rules('ip', 'filter', 'side').length && !rules('inet', 'mgu_uplink', 'fwd').length && !rules('ip6', 'filter', 'INPUT').length, 'a chain that is not on the way got a rule');
            r = loader.nft.open(['wlan_bridge'], 8494, { program: nftProgram, last: r.signature });
            assert(!r.changed && r.chains === 3 && rules('ip', 'filter', 'INPUT').length === 2, 'asked again: rules were added again');
            r = loader.nft.open(['wlan_bridge', 'uap0'], 8494, { program: nftProgram, last: r.signature });
            assert(r.changed && !r.errors.length);
            assert.deepStrictEqual(rules('ip', 'filter', 'INPUT'), ['iifname "wlan_bridge" tcp dport 8494 accept ' + mark, 'iifname "uap0" tcp dport 8494 accept ' + mark, 'ct state established,related accept'], 'a second interface');
            assert.strictEqual(loader.nft.shut({ program: nftProgram }), 6);
            assert.deepStrictEqual([rules('ip', 'filter', 'INPUT'), rules('ip', 'filter', 'OUTPUT'), rules('inet', 'mgu_uplink', 'in')], [['ct state established,related accept'], [], ['iifname "vethuplink" drop']], 'the firewall is not as it was');
            assert.strictEqual(loader.nft.shut({ program: nftProgram }), 0);
            assert.strictEqual(loader.nft.open(['wlan_bridge'], 8494, { program: path.join(tmp, 'no-such-nft') }).errors.length, 1, 'no nft: an error to show, nothing thrown');
        });
        const request = (method, address, body) => new Promise((resolve, reject) => {
            const u = require('url').parse(address);
            const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.path }, (m) => { const parts = []; m.on('data', (d) => parts.push(d)); m.on('end', () => resolve({ status: m.statusCode, type: m.headers['content-type'], body: Buffer.concat(parts).toString() })); });
            r.on('error', reject);
            r.end(body);
        });
        const socket = path.join(tmp, 'loader.sock');
        const said = [];
        const service = loader.service.createService({ listen: socket, oapDir: oap, port: 18493, interfaces: ['lo'], nft: nftProgram, asSelf: true, exit: false, refreshMs: 100, idleMs: 1e9, log: (s) => said.push(s) });
        const phone = new Phone({ socket, log });
        try {
            await check('loader: without the SNES app on the head unit there is no page; without the loader the app says it is missing', async () => {
                phone.open();
                await until('an answer', () => phone.state.step === 'failed');
                assert(/not installed/.test(phone.state.error), phone.state.error);
                phone.close();
                const lost = new Phone({ socket: path.join(tmp, 'no-loader.sock'), log });
                lost.open();
                await until('missing', () => lost.state.step === 'missing');
                lost.close();
                assert.strictEqual(lost.state.step, 'off');
            });
            fs.writeFileSync(path.join(appRoot, 'source', 'package.json'), JSON.stringify({ name: 'clucraft_snes', version: spec0.version }));
            let base = null;
            await check('loader: the app asks, and gets a page on the car Wi-Fi behind an address nobody can guess, its port open in the firewall', async () => {
                fresh();
                phone.open();
                await until('the page', () => phone.state.step === 'open' && phone.state.page.url);
                base = phone.state.page.url;
                assert(/^http:\/\/127\.0\.0\.1:18493\/[0-9a-f]{20}\/$/.test(base), base);
                assert(phone.state.page.nets[0].url === base && phone.state.page.nets.every((n) => n.kind === 'car' && n.name === 'lo'), JSON.stringify(phone.state.page.nets));
                assert.strictEqual(qr(base).version, 3, 'the address fits a small code');
                await until('the rules', () => rules('ip', 'filter', 'INPUT').length === 2);
                assert.deepStrictEqual(rules('ip', 'filter', 'INPUT')[0], 'iifname "lo" tcp dport 18493 accept ' + mark);
                let r = null;
                for (let i = 0; i < 40 && !r; i++) { r = await request('GET', base).catch(() => null); if (!r) await sleep(50); }
                assert(r && r.status === 200 && /^text\/html/.test(r.type) && /Choose games/.test(r.body), 'the page: ' + (r && r.status));
                assert.strictEqual((await request('GET', base.slice(0, -1))).status, 302);
                for (const wrong of ['http://127.0.0.1:18493/', base.replace(/[0-9a-f]\/$/, 'x/'), base.replace(/\/$/, 'ff/'), 'http://127.0.0.1:18493/' + '0'.repeat(20) + '/games']) {
                    assert.strictEqual((await request('GET', wrong)).status, 404, wrong);
                }
            });
            await check('loader: a game sent to the page is in the app\'s games folder and on the app\'s screen; what is no game is not', async () => {
                const roms = path.join(appRoot, 'data', 'roms');
                let r = await request('POST', base + 'games?name=' + encodeURIComponent('../../Sent from a phone (v1).sfc'), game);
                assert.deepStrictEqual([r.status, JSON.parse(r.body)], [200, { ok: true, name: 'Sent from a phone (v1).sfc', size: game.length, replaced: false }]);
                assert(fs.readFileSync(path.join(roms, 'Sent from a phone (v1).sfc')).equals(game));
                r = await request('POST', base + 'games?name=notes.txt', game);
                assert(r.status === 400 && JSON.parse(r.body).ok === false);
                r = await request('POST', base + 'games?name=broken.sfc', Buffer.alloc(40000, 3));
                assert(r.status === 400 && /not an SNES game/.test(JSON.parse(r.body).error));
                r = await request('POST', base + 'games?name=huge.sfc', Buffer.concat([game.slice(0, 16), Buffer.alloc(loader.games.MAX_GAME)])).catch((e) => ({ status: 413, body: e.code }));
                assert.strictEqual(r.status, 413, 'more than the app reads is cut off');
                assert.deepStrictEqual(fs.readdirSync(roms), ['Sent from a phone (v1).sfc'], 'the games folder');
                assert.deepStrictEqual(fs.readdirSync(path.join(appRoot, 'data')), ['roms'], 'nothing beside the games folder');
                assert.deepStrictEqual(JSON.parse((await request('GET', base + 'games')).body), { games: [{ name: 'Sent from a phone (v1).sfc', size: game.length }] });
                await until('the app hearing of it', () => (phone.state.page.saved || []).length >= 3);
                const heard = phone.state.page.saved;
                assert(heard[0].name === 'Sent from a phone (v1).sfc' && !heard[0].refused && heard[1].refused && heard[2].refused, JSON.stringify(heard));
                // the app finds it as any game in its folder
                const lib = new Library({ packs: [], dirs: [roms], dataDir: tmp, log });
                assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Sent from a phone']);
                assert.strictEqual((await request('DELETE', base + 'games?name=' + encodeURIComponent('sent from a phone (v1).sfc'))).status, 200);
                assert.deepStrictEqual(fs.readdirSync(roms), []);
            });
            await check('loader: when the app leaves the screen the page is gone, and the firewall is as it was', async () => {
                phone.close();
                await until('the rules gone', () => rules('ip', 'filter', 'INPUT').length === 1 && !rules('ip', 'filter', 'OUTPUT').length && rules('inet', 'mgu_uplink', 'in').length === 1);
                await until('the page gone', () => service.status().page.open === false);
                let r = 'answered';
                for (let i = 0; i < 40 && r === 'answered'; i++) { r = await request('GET', base).then(() => 'answered', (e) => e.code); if (r === 'answered') await sleep(50); }
                assert.strictEqual(r, 'ECONNREFUSED', 'the page still answers');
                // and when the app goes without a word (it crashed): the same
                // (this time asked for on a Wi-Fi the head unit has joined, as the app's setting has it: the loader says which kind)
                const gone = new Phone({ socket, log, joined: () => true });
                gone.open();
                await until('a page again', () => gone.state.step === 'open' && rules('ip', 'filter', 'INPUT').length === 2);
                assert.notStrictEqual(gone.state.page.url, base, 'the same address twice');
                assert(gone.state.page.nets.length && gone.state.page.nets.every((n) => n.kind === 'joined'), JSON.stringify(gone.state.page.nets));
                assert(said.some((l) => /page open for .*on a Wi-Fi the head unit has joined too/.test(l)), said.join(' | '));
                gone.conn.destroy();
                gone.wanted = false;
                await until('the rules gone again', () => rules('ip', 'filter', 'INPUT').length === 1);
                assert(said.some((l) => /page closed: the app left/.test(l)), said.join(' | '));
            });
        } finally {
            phone.close();
            service.stop(0);
        }

        // The folders as a car has them (read on one, 2026-11-20): the apps' folder opens to a group the head
        // unit gives its apps' processes, the app's folder belongs to whoever installed it. A page started as the
        // folder's owner, or outside it, answered a game with "the car could not save it (EACCES)" there.
        if (process.getuid() !== 0) console.log('skip loader: the page as the app\'s own user, in an app\'s folder as a head unit has it (as root alone: wsl -u root)');
        else await check('loader: as on a head unit, the page is the app\'s own user and saves a game in a folder that user cannot get to from outside', async () => {
            const door = path.join(tmp, 'door'), root = path.join(door, 'oap_12244'), data = path.join(root, 'data'), roms = path.join(data, 'roms');
            const dir = (d, mode, uid, gid) => { fs.mkdirSync(d); fs.chownSync(d, uid, gid); fs.chmodSync(d, mode); };
            dir(door, 0o770, 8000, 903);
            dir(root, 0o750, 12201, 12244);
            dir(path.join(root, 'source'), 0o750, 12201, 12244);
            dir(data, 0o770, 12201, 12244);
            fs.writeFileSync(path.join(root, 'source', 'package.json'), JSON.stringify({ name: 'clucraft_snes' }));
            const lines = [], at = path.join(tmp, 'door.sock');
            const behind = loader.service.createService({ listen: at, oapDir: door, port: 18494, interfaces: ['lo'], nft: null, exit: false, refreshMs: 100, idleMs: 1e9, log: (s) => lines.push(s) });
            const asker = new Phone({ socket: at, log });
            try {
                asker.open();
                await until('the page', () => asker.state.step === 'open' && asker.state.page.url);
                const url = asker.state.page.url;
                let r = null;
                for (let i = 0; i < 40 && !r; i++) { r = await request('GET', url + 'games').catch(() => null); if (!r) await sleep(50); }
                assert(r, 'the page does not answer: ' + lines.join(' | '));
                assert.deepStrictEqual([r.status, JSON.parse(r.body)], [200, { games: [] }]);
                r = await request('POST', url + 'games?name=Behind.sfc', game);
                assert.strictEqual(r.status, 200, r.body + ' ' + lines.join(' | '));
                const st = fs.statSync(path.join(roms, 'Behind.sfc')), folder = fs.statSync(roms);
                assert.deepStrictEqual([st.uid, st.gid, folder.uid, folder.gid], [12244, 12244, 12244, 12244], 'whose the game and its folder are');
                assert(fs.readFileSync(path.join(roms, 'Behind.sfc')).equals(game));
                assert.deepStrictEqual(JSON.parse((await request('GET', url + 'games')).body), { games: [{ name: 'Behind.sfc', size: game.length }] });
                assert(lines.some((l) => /page open for .*as user 12244/.test(l)) && !lines.some((l) => /cannot use the games folder/.test(l)), lines.join(' | '));
                asker.close();
                await until('the page gone', () => behind.status().page.open === false);
                // a link where the data folder was: root does not walk into what it points at
                fs.renameSync(data, path.join(root, 'elsewhere'));
                fs.symlinkSync(path.join(root, 'elsewhere'), data);
                asker.open();
                await until('an answer', () => asker.state.step === 'failed');
                assert(/no data folder/.test(asker.state.error), asker.state.error);
            } finally {
                asker.close();
                behind.stop(0);
            }
        });
    }

    /* ---------- a USB gamepad, from the program that reads it to the app (a stand-in for that program: test/fake-usbpipe.js) ---------- */
    {
        // (Windows has pipes of this kind of name where other systems have socket files)
        const sock = (name) => (process.platform === 'win32' ? '\\\\.\\pipe\\snes-test-' + process.pid + '-' + name : path.join(tmp, name + '.sock'));
        const padLog = path.join(tmp, 'pad.log'), wrote = () => (fs.existsSync(padLog) ? fs.readFileSync(padLog, 'utf8').split('\n').filter(Boolean) : []);
        // the pad, once switched on: A; let go and left on the D-pad; the stick right with X; Menu; nothing; the
        // Xbox button, which wants an answer; and then it waits to be pulled out
        const does = [report(0x10, 0), report(0, 0x04), report(0x40, 0, 30000, 0), report(0x04, 0), report(0, 0)].map((b) => b.toString('hex')).concat(['07302a02015b', 'pulled']).join(',');
        const dev = { kind: 'gip', node: '/dev/bus/usb/001/004', iface: 0, epIn: 0x82, epOut: 0x02, packet: 64, vid: 0x045e, pid: 0x02ea, name: 'Controller' };
        const padSaid = [], seen = [], own = [];
        let plugged = false;
        const padService = loader.service.createService({ listen: sock('pad'), nft: null, asSelf: true, exit: false, idleMs: 1e9, padScanMs: 40, padFind: () => (plugged ? [dev] : []),
            padPipe: [process.execPath, path.join(ROOT, 'test', 'fake-usbpipe.js'), padLog, does], padEnv: process.env, log: (s) => padSaid.push(s) });
        const pad = new Pad({ socket: sock('pad'), log, onMask: (m) => seen.push(m), onButtons: (b) => own.push(b) });
        try {
            await check('gamepad: the app asks while a game runs; a pad plugged in then is switched on, and its buttons are the SNES pad\'s in the app', async () => {
                pad.start();
                await until('the loader\'s answer', () => padService.status().pad.on === true);
                await sleep(150);
                assert(pad.name === null && !seen.length && !wrote().length, 'no pad is plugged in yet');
                plugged = true;
                await until('its buttons', () => seen.length >= 5);
                // (by where they are: the Xbox pad's A is the SNES pad's B, its X the Y)
                assert.deepStrictEqual(seen, [BTN.B, BTN.LEFT, BTN.RIGHT | BTN.Y, BTN.START, 0]);
                assert.deepStrictEqual(own.slice(0, 5), [PAD.A, PAD.LEFT, PAD.RIGHT | PAD.X, PAD.START, 0], 'the pad\'s own buttons, for the tabs');
                assert.strictEqual(pad.name, 'Controller');
                const log0 = wrote();
                assert.strictEqual(log0[0], 'args /dev/bus/usb/001/004 0 82 2 64', 'what the program is started with');
                assert.deepStrictEqual(log0.slice(1, 5), ['out 0520000100', 'out 0520010f06', 'out 0a200203000114', 'out 062003020100'], 'what switches the pad on');
                await until('the answer to the Xbox button', () => wrote().indexOf('out 01202a09000720020000000000') >= 0);
                await until('the Xbox button in the app', () => own.indexOf(PAD.GUIDE) >= 0);
                assert(wantsOut(own[own.length - 1]) && seen.length === 5, 'the Xbox button is the way out of a game, and no button of the game\'s');
                assert.strictEqual(padService.status().page.open, false, 'a gamepad opens no page and no port');
            });
            await check('gamepad: pulled out, it is gone for the app; plugged in again, it is read again; the game stopping lets go of it', async () => {
                plugged = false;
                fs.writeFileSync(padLog + '.pull', '');
                await until('the pad gone', () => wrote().indexOf('gone') >= 0 && pad.name === null && padService.status().pad.name === null);
                assert(padSaid.some((l) => /gamepad: unplugged/.test(l)), padSaid.join(' | '));
                assert.strictEqual(seen.length, 5, 'buttons from a pad that is gone');
                fs.unlinkSync(padLog + '.pull');
                plugged = true;
                await until('the pad again', () => wrote().filter((l) => /^args /.test(l)).length === 2 && seen.length >= 6);
                assert.strictEqual(seen[5], BTN.B);
                pad.stop();
                assert.strictEqual(seen[seen.length - 1], 0, 'a button held when the game stops is let go');
                await until('the loader letting go', () => padService.status().pad.on === false && wrote().indexOf('end') >= 0);
                const n = seen.length;
                await sleep(200);
                assert.strictEqual(seen.length, n, 'buttons after the game stopped');
            });
            await check('gamepad: read by a program of one\'s own, the whole pad is told whenever anything of it changes, and its buttons as the loader gets them', async () => {
                const log2 = path.join(tmp, 'pad-whole.log'), states = [], bits = [], P = loader.pad.PAD, F = loader.pad.PAD_FULL;
                const st = (buttons, lt, rt, lx, ly, rx, ry) => ({ buttons, lt, rt, lx, ly, rx, ry });
                // a trigger pulled a little, then all the way; the same again; let go, with A and the right stick
                // pressed in and out to the left; all let go
                const steps = [whole(0, 0, 0, 200, 0, 0, 0, 0), whole(0, 0, 0, 1023, 0, 0, 0, 0), whole(0, 0, 0, 1023, 0, 0, 0, 0), whole(0x10, 0x80, 0, 0, 0, 0, -20000, 9), whole(0, 0, 0, 0, 0, 0, 0, 0)]
                    .map((b) => b.toString('hex')).concat(['pulled']).join(',');
                let closed = null;
                const reader = loader.pad.open(dev, { pipe: [process.execPath, path.join(ROOT, 'test', 'fake-usbpipe.js'), log2, steps], env: process.env,
                    onState: (s) => states.push(s), onButtons: (b) => bits.push(b), onClose: (why) => { closed = why; } });
                try {
                    await until('the pad at rest again', () => states.length >= 4);
                    assert.deepStrictEqual(states, [st(0, 0, 200, 0, 0, 0, 0), st(0, 0, 1023, 0, 0, 0, 0), st(P.A | F.RS, 0, 0, 0, 0, -20000, 9), st(0, 0, 0, 0, 0, 0, 0)]);
                    assert.deepStrictEqual(bits, [P.A | F.RS, 0], 'a trigger is no button; a stick pressed in is told, as the loader tells the SNES app');
                } finally { reader.close(); }
                await until('the program let go of', () => fs.existsSync(log2) && fs.readFileSync(log2, 'utf8').split('\n').indexOf('end') >= 0);
                assert.strictEqual(closed, null, 'let go of by its reader, it does not say it ended');
            });
            await check('gamepad: a program that cannot read the pad is not started over and over; a loader from before gamepads is asked once', async () => {
                const said = [];
                const broken = loader.service.createService({ listen: sock('pad-broken'), nft: null, asSelf: true, exit: false, idleMs: 1e9, padScanMs: 20, padFind: () => [dev],
                    padPipe: [process.execPath, '-e', 'console.error("snes-usbpipe: interface 0 of /dev/bus/usb/001/004: permission denied"); process.exit(2)'], padEnv: process.env, log: (s) => said.push(s) });
                const p = new Pad({ socket: sock('pad-broken'), log, onMask: (m) => seen.push(m) });
                try {
                    p.start();
                    await until('giving up', () => p.given === true);
                    assert(/cannot be read.*permission denied/.test(p.said), p.said);
                    const tries = said.filter((l) => /Controller \(045e:02ea\)/.test(l)).length;
                    await sleep(200);
                    assert.strictEqual(said.filter((l) => /Controller \(045e:02ea\)/.test(l)).length, tries, 'started again after giving up');
                    assert(tries >= 2 && tries <= 5, tries + ' tries');
                } finally { p.stop(); broken.stop(0); }
                let asked = 0;
                const old = net.createServer((c) => { asked++; c.on('error', () => {}); c.on('data', () => c.write('{"ok":false,"error":"unknown: pad"}\n')); });
                await new Promise((r) => old.listen(sock('pad-old'), r));
                const q = new Pad({ socket: sock('pad-old'), log });
                try {
                    q.start();
                    await until('its answer', () => q.given === true);
                    await sleep(150);
                    assert.strictEqual(asked, 1);
                } finally { q.stop(); old.close(); }
            });
        } finally {
            pad.stop();
            padService.stop(0);
        }
    }

    /* ---------- a game's sound: the app, the loader, the program that plays it, and the car's speakers ---------- */
    {
        const sock = (name) => (process.platform === 'win32' ? '\\\\.\\pipe\\snes-test-' + process.pid + '-' + name : path.join(tmp, name + '.sock'));
        const soundLog = path.join(tmp, 'sound.log'), wrote = () => (fs.existsSync(soundLog) ? fs.readFileSync(soundLog, 'utf8').split('\n').filter(Boolean) : []);
        const pcm = () => (fs.existsSync(soundLog + '.pcm') ? fs.readFileSync(soundLog + '.pcm') : Buffer.alloc(0));
        const said = [];
        const service = loader.service.createService({ listen: sock('sound'), nft: null, asSelf: true, exit: false, idleMs: 1e9,
            soundPipe: [process.execPath, path.join(ROOT, 'test', 'fake-sound.js'), soundLog], soundEnv: process.env, soundAgainMs: 30, log: (s) => said.push(s) });
        const states = [];
        const sound = new Sound({ socket: sock('sound'), log, onChange: (s) => states.push(s.step + (s.player ? ' ' + s.player : '')) });
        try {
            await check('sound: the app asks while a game runs; what it sends then reaches the program that plays it, whole and in order, and what that program says comes back', async () => {
                assert.strictEqual(sound.write(Buffer.alloc(400, 1)), false, 'sound taken before anybody asked for it');
                sound.start(48000);
                await until('the loader\'s yes', () => sound.ready);
                assert.strictEqual(service.status().sound.on, true);
                const sent = [];
                for (let i = 0; i < 20; i++) {
                    const b = Buffer.alloc(3196, i + 1); b.writeUInt32LE(i, 0); sent.push(b); assert(sound.write(b), 'part ' + i + ' not sent'); await sleep(5);
                    // (the stand-in says it waits with the first sound it gets: the second part goes once it has said so)
                    if (!i) await until('the program waiting for the speakers', () => states.indexOf('on waiting') >= 0);
                }
                const all = Buffer.concat(sent);
                await until('all of it', () => pcm().length >= all.length);
                assert(pcm().equals(all), 'what was played is not what was sent');
                await until('playing', () => sound.state.player === 'playing');
                assert.deepStrictEqual(wrote()[0], 'args ' + loader.sound.DEVICE + ' 48000', 'what the program is started with');
                assert(states.indexOf('on waiting') >= 0 && states[states.length - 1] === 'on playing', states.join(' | '));
                assert(said.some((l) => /sound: the app sends a game's, 48000 samples a second/.test(l)) && said.some((l) => l === 'sound: playing'), said.join(' | '));
                assert.strictEqual(service.status().page.open, false, 'a sound opens no page and no port');
                // the lines of other connections are still lines
                const other = new Phone({ socket: sock('sound'), log });
                other.open();
                await until('an answer to another connection', () => other.state.step !== 'off' && other.state.step !== 'asking');
                other.close();
            });
            await check('sound: when the game stops the program\'s input ends and it goes; asked again, it plays again; far too much at once is not sent', async () => {
                sound.stop();
                await until('the program gone', () => wrote().indexOf('end') >= 0 && service.status().sound.on === false);
                assert.strictEqual(sound.state.step, 'off');
                assert(said.some((l) => /sound: no longer played: the app left/.test(l)), said.join(' | '));
                sound.start(44100);
                await until('the loader\'s yes again', () => sound.ready && wrote().filter((l) => /^args/.test(l)).length === 2);
                assert.strictEqual(wrote().filter((l) => /^args/.test(l))[1], 'args ' + loader.sound.DEVICE + ' 44100');
                let refused = 0;
                for (let i = 0; i < 64; i++) if (!sound.write(Buffer.alloc(65536))) refused++;      // 4 MiB in one go: 20 s of sound
                assert(refused > 0, 'everything was taken: the sound would run late');
                sound.stop();
            });
            await check('sound: a program that cannot play is not started over and over, and the app is told why; without one, or with a loader from before, the app is told once', async () => {
                const log2 = [];
                const broken = loader.service.createService({ listen: sock('sound-broken'), nft: null, asSelf: true, exit: false, idleMs: 1e9, soundAgainMs: 20, log: (s) => log2.push(s),
                    soundPipe: [process.execPath, '-e', 'console.log(JSON.stringify({ ev: "error", error: "dlopen libasound.so.2: no such file" })); process.exit(3)'], soundEnv: process.env });
                const s = new Sound({ socket: sock('sound-broken'), log });
                try {
                    s.start(48000);
                    await until('giving up', () => s.state.player === 'error');
                    assert(/libasound/.test(s.state.error), s.state.error);
                    assert(log2.some((l) => /not tried again/.test(l)), log2.join(' | '));
                } finally { s.stop(); broken.stop(0); }
                const none = loader.service.createService({ listen: sock('sound-none'), nft: null, asSelf: true, exit: false, idleMs: 1e9, soundPipe: null, log: () => {} });
                const t = new Sound({ socket: sock('sound-none'), log });
                try {
                    t.start(48000);
                    await until('its answer', () => t.given === true);
                    assert(t.state.step === 'failed' && /No sound on this computer/.test(t.state.error), JSON.stringify(t.state));
                    assert.strictEqual(t.write(Buffer.alloc(64)), false);
                } finally { t.stop(); none.stop(0); }
                let asked = 0;
                const old = net.createServer((c) => { asked++; c.on('error', () => {}); c.on('data', () => c.write('{"ok":false,"error":"unknown: sound"}\n')); });
                await new Promise((r) => old.listen(sock('sound-old'), r));
                const q = new Sound({ socket: sock('sound-old'), log });
                try {
                    q.start(48000);
                    await until('its answer', () => q.given === true);
                    await sleep(150);
                    assert(asked === 1 && /update it in the MGU Store/.test(q.state.error), asked + ' ' + q.state.error);
                } finally { q.stop(); old.close(); }
            });
        } finally {
            sound.stop();
            service.stop(0);
        }
        await check('sound: the program that plays runs as nobody in the head unit\'s sound group, by the head unit\'s own numbers; without that group there is no sound', () => {
            const etc = path.join(tmp, 'etc');
            fs.mkdirSync(etc);
            fs.writeFileSync(path.join(etc, 'passwd'), 'root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/:/sbin/nologin\n');
            fs.writeFileSync(path.join(etc, 'group'), 'root:x:0:\nmgu_usb:x:912:\nmgu_alsa:x:905:ent_audiomanager,nobody\n');
            assert.deepStrictEqual(loader.sound.ids(etc), { uid: 65534, gid: 905 });
            fs.writeFileSync(path.join(etc, 'group'), 'root:x:0:\nmgu_alsa_x:x:906:\n');
            assert.throws(() => loader.sound.ids(etc), /no group "mgu_alsa"/);
            assert.throws(() => loader.sound.ids(path.join(tmp, 'no-etc')), /no user "nobody"/);
        });
        await check('sound: the car\'s speakers are asked for as other apps ask: source 287 made available and connected to the front speakers, and only this app\'s connection ended', async () => {
            const calls = [], list = [{ mainConnectionID: 7, sourceID: 12, sinkID: 1024 }];
            let next = 40;
            const signals = {
                proxy: async (iface) => ({ iface }),
                call: async (p, method, args) => {
                    calls.push(method + ' ' + JSON.stringify(args));
                    if (method === 'getListMainConnections') return { listConnections: list.slice() };
                    if (method === 'connect') { list.push({ mainConnectionID: ++next, sourceID: args.sourceID, sinkID: args.sinkID }); return { amError: 'E_OK', mainConnectionID: next }; }
                    if (method === 'disconnect') { const i = list.findIndex((c) => c.mainConnectionID === args.mainConnectionID); if (i >= 0) list.splice(i, 1); return { amError: 'E_OK' }; }
                    return {};
                },
            };
            const file = path.join(tmp, 'speakers.json');
            const audio = createCarAudio(signals, log, file, { retryMs: 20 });
            audio.want(true);
            await until('connected', () => audio.state().connected);
            assert.deepStrictEqual(calls.filter((c) => !/^getList/.test(c)), [
                'hookSourceAvailablityStatusChange {"sourceID":287,"availability":{"availability":"A_AVAILABLE","availabilityReason":0}}',
                'connect {"sourceID":287,"sinkID":1024}']);
            assert.deepStrictEqual(list.map((c) => c.mainConnectionID), [7, 41]);
            audio.want(true);                                       // (asked again and again: nothing more)
            await sleep(60);
            assert.strictEqual(calls.filter((c) => /^connect/.test(c)).length, 1);
            calls.length = 0;
            audio.want(false);
            await until('hung up', () => !audio.state().connected);
            assert.deepStrictEqual(calls.filter((c) => !/^getList/.test(c)), ['disconnect {"mainConnectionID":41}',
                'hookSourceAvailablityStatusChange {"sourceID":287,"availability":{"availability":"A_UNAVAILABLE","availabilityReason":0}}']);
            assert.deepStrictEqual(list.map((c) => c.mainConnectionID), [7], 'another source\'s connection was touched');
            assert(!fs.existsSync(file), 'the connection\'s number is kept though it is gone');
        });
        // the program itself, where it can run: Linux for the head unit's processor. Its loader is where the head
        // unit has it, which is not where a PC's Linux has it, so it is started through the PC's.
        const ld = '/lib64/ld-linux-x86-64.so.2', player = path.join(ROOT, 'loader', 'snes-sound');
        if (process.platform !== 'linux' || process.arch !== 'x64' || !fs.existsSync(ld)) console.log('skip sound: the program that plays it, loader/snes-sound, run on a tone (it is a Linux program for x86-64)');
        else {
            const run = (args, env, feed) => new Promise((resolve) => {
                const { spawn } = require('child_process');
                const c = spawn(ld, [player].concat(args), { env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'] });
                let out = '';
                c.stdout.on('data', (d) => { out += d; });
                c.stdin.on('error', () => {});
                c.on('exit', (code) => resolve({ code, events: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
                feed(c.stdin);
            });
            /** seconds of a note at rate, handed over as a game hands its sound over: in pieces, as much as the clock says is due */
            const note = (stdin, rate, hz, seconds) => new Promise((done) => {
                const t0 = Date.now(), total = Math.round(seconds * rate);
                let n = 0;
                const t = setInterval(() => {
                    const due = Math.min(total, Math.round((Date.now() - t0) * rate / 1000)) - n;
                    if (due > 0) {
                        const b = Buffer.alloc(due * 4);
                        for (let k = 0; k < due; k++, n++) { const v = Math.round(9000 * Math.sin(2 * Math.PI * hz * n / rate)); b.writeInt16LE(v, k * 4); b.writeInt16LE(-v, k * 4 + 2); }
                        stdin.write(b);
                    }
                    if (n >= total) { clearInterval(t); setTimeout(() => { stdin.end(); done(); }, 150); }
                }, 8);
            });
            await check('sound: the program plays a note at the device\'s 48000 samples a second as the note it is, from an SNES core\'s 32040 a second, and from 48000 and 44100, and ends with its input', async () => {
                for (const rate of [32040, 48000, 44100]) {
                    const file = path.join(tmp, 'played-' + rate + '.raw');
                    // (as root, as this suite also runs, it plays only when told that it may: the loader never tells it)
                    const r = await run(['a-device', String(rate)], { SNES_SOUND_OUT: 'file:' + file, SNES_SOUND_AS_ROOT: '1' }, (stdin) => note(stdin, rate, 440, 1.5));
                    assert.strictEqual(r.code, 0, JSON.stringify(r.events));
                    assert(r.events.some((e) => e.ev === 'open' && e.device === 'a-device' && e.rate === rate) && r.events.some((e) => e.ev === 'playing'), JSON.stringify(r.events));
                    const b = fs.readFileSync(file), h = heard(b);
                    // (what is not silence: the note starts once 40 ms of it wait, and silence follows it until the input ends)
                    let first = 0, end = h.frames;
                    while (first < h.frames && Math.abs(b.readInt16LE(first * 4)) < 200) first++;
                    while (end > first && Math.abs(b.readInt16LE((end - 1) * 4)) < 200) end--;
                    const loud = heard(b.slice(first * 4, end * 4)), seconds = loud.frames / 48000;
                    assert(seconds > 1.2 && seconds < 1.7, rate + ': ' + seconds.toFixed(2) + ' s of the note');
                    assert(Math.abs(loud.cycles / seconds - 440) < 6, rate + ': ' + (loud.cycles / seconds).toFixed(1) + ' Hz');
                    assert(loud.peak > 8000 && loud.peak <= 9001, rate + ': peak ' + loud.peak);
                    for (let i = first; i < h.frames; i += 97) assert(Math.abs(b.readInt16LE(i * 4) + b.readInt16LE(i * 4 + 2)) <= 2, 'left and right are not what was sent');
                }
            });
            await check('sound: the program reaches the C library\'s own loader of libraries (it has no sound library on a PC, and says so), and does not run as root', async () => {
                const r = await run(['plug:smartx:CarLifeMedia_CF_48_STEREO', '48000'], { SNES_SOUND_OUT: '' }, (stdin) => stdin.end());
                if (process.getuid() === 0) assert(r.code === 2 && /not as root/.test(r.events[0].error), JSON.stringify(r));
                else if (r.events.some((e) => e.ev === 'open')) console.log('     (this PC has a sound library and that device: played to it)');
                else assert(r.events.length >= 1 && /libasound\.so\.2|snd_pcm_open/.test(r.events[0].error), JSON.stringify(r));
            });
        }
    }

    /* ---------- the MGU Store: mgu-repo.json and store/ (the Store's docs/PUBLISHING.md, "Repo tree") ---------- */
    const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const SEMVER = /^\d+\.\d+\.\d+$/, relPath = (p) => typeof p === 'string' && !!p && !path.isAbsolute(p) && p.split('/').indexOf('..') < 0;
    const spec = json('app/app.json');
    let entry = null, output = null, members = [];
    await check('store: mgu-repo.json lists the app with a build script and a committed output', () => {
        const repo = json('mgu-repo.json');
        assert(repo.schema === 1 && Array.isArray(repo.components) && repo.components.length === 1, 'schema 1 with one component');
        entry = repo.components[0];
        assert.strictEqual(entry.id, spec.id);
        assert(/^[a-z0-9]+_[a-z0-9_]+$/.test(entry.id), 'the id has a prefix of its own: ' + entry.id);
        assert(entry.kind === 'app' && relPath(entry.path), 'kind app and a path in the repository');
        const b = entry.build;
        assert(b && relPath(b.node) && b.python === undefined && fs.existsSync(path.join(ROOT, b.node)), 'build.node names a script in the repository');
        assert(Array.isArray(b.args) && b.args.every((a) => typeof a === 'string') && !b.network && !b.sdk, 'args are strings; no network, no SDK folder');
        // (with "shared", an install downloads the app's folder, these and the script, not the whole repository)
        assert(Array.isArray(b.shared) && b.shared.length && b.shared.every((f) => relPath(f) && fs.existsSync(path.join(ROOT, f))), 'build.shared names files in the repository');
        assert(Array.isArray(entry.mguHmi) && entry.mguHmi.length && entry.mguHmi.every((h) => h === 'ID7' || h === 'ID8'), 'mguHmi');
        assert(Array.isArray(entry.needs) && entry.needs.every((n) => /^[a-z][a-z0-9-]*$/.test(n)), 'needs: capabilities');
        assert(Object.keys(entry.requires).every((k) => k !== entry.id && SEMVER.test(entry.requires[k])), 'requires: ids to x.y.z versions');
    });
    await check('store: store/app.json is this version of the app, with a title, a description and an icon', () => {
        const m = json(path.join(entry.path, 'app.json'));
        assert.strictEqual(m.id, entry.id);
        assert.strictEqual(m.version, spec.version, 'store/ is version ' + m.version + ', app/app.json ' + spec.version + ': run "npm run build:store"');
        assert(SEMVER.test(m.version) && m.title === spec.title && m.description === spec.description && m.description.length > 20);
        const icon = fs.readFileSync(path.join(ROOT, entry.path, 'icon.png'));
        assert(icon.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && icon.length <= 128 << 10, 'icon.png: a PNG of at most 128 KiB');
        assert(icon.readUInt32BE(16) === 140 && icon.readUInt32BE(20) === 140, 'icon.png is 140 x 140');
        assert(icon.equals(fs.readFileSync(path.join(ROOT, 'app/icon.png'))), 'it is the app\'s own icon');
        const fill = (t) => t.replace(/\{id\}/g, entry.id).replace(/\{version\}/g, m.version).replace(/\{dir\}/g, entry.path);
        output = fill(entry.build.output);
        assert(relPath(output) && fs.existsSync(path.join(ROOT, output)), 'the build\'s output ' + output + ' is in the repository');
        assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, entry.path)).filter((f) => /\.tgz$/.test(f)), [path.basename(output)], 'one package in store/');
    });
    await check('store: the package is an OAP package of that id and version, without an SDK and without games of anyone\'s', () => {
        members = unpack(fs.readFileSync(path.join(ROOT, output)));
        assert(members.length > 50 && members.every((m) => m.name.indexOf('package/') === 0 && m.name.indexOf('..') < 0), 'its files are under package/');
        const bad = members.filter((m) => /node_modules|oap-sdk\/|roms\.pack$|\.(sfc|smc)$/i.test(m.name)).map((m) => m.name);
        assert(!bad.length, 'must not be published: ' + bad.join(' '));
        const pkg = JSON.parse(members.find((m) => m.name === 'package/package.json').data.toString());
        assert(pkg.name === entry.id && pkg.version === spec.version && pkg.main === 'javascript/app.js', pkg.name + '@' + pkg.version);
        assert.deepStrictEqual(pkg.mguHmi, entry.mguHmi);
        // its licence is not one with a short name: it points at NOTICE, and carries both licences' texts
        assert.strictEqual(pkg.license, 'SEE LICENSE IN javascript/NOTICE');
        const text = (n) => members.find((m) => m.name === 'package/javascript/' + n).data.toString().replace(/\r\n/g, '\n');
        const norm = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
        assert(/NON-COMMERCIAL USE ONLY/.test(text('NOTICE')) && /snes9x2005/.test(text('NOTICE')), 'NOTICE does not say what the package may be used for');
        assert(text('LICENSE').indexOf(norm('LICENSE')) >= 0, 'this project\'s licence is not in the package\'s LICENSE');
        assert(text('LICENSE').indexOf(norm('vendor/snes9x2005/copyright')) >= 0, 'the emulator core\'s own licence file is not in the package\'s LICENSE, whole');
        assert(/for non-commercial purposes/.test(text('LICENSE')) && norm('LICENSE.snes9x2005') === norm('vendor/snes9x2005/copyright'), 'the core\'s licence at the repository\'s top is not the core\'s');
        assert.strictEqual(spawnSync(process.execPath, [path.join(ROOT, 'tools/licenses.js'), '--check']).status, 0, 'app/LICENSE or app/NOTICE is not what tools/licenses.js writes');
        ['package/rhmiData/application.json', 'package/manifest.json', 'package/permissions.json', 'package/javascript/kit/mgu.js'].forEach((n) => assert(members.some((m) => m.name === n), n + ' is missing'));
        // the head unit generates the oap-sdk module for a package whose javascript asks for it and ships none
        assert(/require\(['"]oap-sdk['"]\)/.test(members.find((m) => m.name === 'package/javascript/kit/mgu.js').data.toString()));
    });
    await check('store: the package holds this app/ (else: npm run build:store)', () => {
        const inPkg = (n) => { const m = members.find((x) => x.name === 'package/javascript/' + n); assert(m, n + ' is not in the package'); return m.data; };
        [['app.js', 'main.js'], ['controls.js'], ['library.js'], ['snes-core.js'], ['phone.js'], ['pad.js'], ['qr.js'], ['tabs.js'], ['sound.js'], ['caraudio.js'], ['snes.wasm'], ['snes-plus.wasm'], ['LICENSE'], ['NOTICE']].forEach((q) => {
            assert(inPkg(q[0]).equals(fs.readFileSync(path.join(ROOT, 'app', q[1] || q[0]))), 'app/' + (q[1] || q[0]) + ' changed since the package was built');
        });
        // the game in it: the app's own, as it is in app/games/
        const packed = path.join(tmp, 'store-games.pack');
        fs.writeFileSync(packed, inPkg('games.pack'));
        const pack = openPack(packed);
        assert(pack, 'games.pack is no data pack');
        assert.deepStrictEqual(pack.names.slice().sort(), BUNDLED, 'the games in the package');
        BUNDLED.forEach((n) => assert(pack.read(n).equals(bundled(n)), 'app/games/' + n + ' changed since the package was built'));
        const rt = JSON.parse(inPkg('kit/app-spec.json').toString());
        ['id', 'title', 'version', 'screens', 'settings', 'config'].forEach((k) => assert.deepStrictEqual(rt[k], spec[k], 'app/app.json "' + k + '" changed since the package was built'));
    });
    await check('store: the SNES game loader is listed as a tool the Store can pack: its files and units are there, its hooks among them', () => {
        const repo = json('mgu-repo.json');
        assert(Array.isArray(repo.tools) && repo.tools.length === 1, 'one tool');
        const tool = repo.tools[0], c = json(path.join(tool.path, 'component.json'));
        assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tool.id) && tool.id !== spec.id && relPath(tool.path) && tool.build === undefined, 'its entry');
        assert(c.id === tool.id && c.kind === 'tool' && SEMVER.test(c.version) && c.build === undefined, 'component.json names ' + tool.id + ', a tool with a version and no build step');
        assert.strictEqual(c.version, loader.service.VERSION, 'the service says another version than component.json');
        assert(tool.optional === true && tool.uninstallable === true && Array.isArray(tool.mguHmi), 'optional, removable, for named head units');
        assert(Object.keys(c.requires).every((k) => k !== c.id && SEMVER.test(c.requires[k])) && c.requires['mgu-deploy'], 'requires the deploy tool its "deactivate" needs');
        const inFolder = (rel) => relPath(rel) && fs.existsSync(path.join(ROOT, tool.path, rel));
        c.files.forEach((f) => assert(relPath(f.path) && /^[0-7]{3,4}$/.test(f.mode) && inFolder(f.from || f.path), 'file ' + JSON.stringify(f)));
        c.units.forEach((u) => assert(/^[A-Za-z0-9@_.-]+\.(service|socket)$/.test(u.name) && inFolder(u.from || u.name), 'unit ' + JSON.stringify(u)));
        const paths = c.files.map((f) => f.path), units = c.units.map((u) => u.name);
        // every .js the service loads is installed with it
        fs.readdirSync(path.join(ROOT, tool.path)).filter((f) => /\.js$/.test(f)).forEach((f) => assert(paths.indexOf(f) >= 0, f + ' is not among the files'));
        assert(paths.indexOf(c.check[0]) >= 0 && c.deactivate[0] === 'node' && paths.indexOf(c.deactivate[1]) >= 0, 'check and deactivate are files of the tool');
        c.enable.forEach((e) => assert(units.indexOf(e.unit) >= 0, 'enabled: ' + e.unit));
        c.restart.forEach((u) => assert(units.indexOf(u) >= 0, 'restarted: ' + u));
        assert(c.recmgr.every((n) => /^[A-Za-z0-9:._+@-]+$/.test(n)));
        // the units run what the Store installs, where it installs it
        const unitText = (n) => fs.readFileSync(path.join(ROOT, tool.path, c.units.find((u) => u.name === n).from), 'utf8');
        const svc = unitText(tool.id + '.service'), sock = unitText(tool.id + '.socket');
        ['service.js', 'cleanup.js'].forEach((f) => assert(svc.indexOf('/var/opt/' + tool.id + '/current/' + f) >= 0, 'the service unit runs ' + f));
        assert(/^LimitCORE=1$/m.test(svc) && !/^WantedBy=/m.test(svc), 'the service: no core files, and not started at boot');
        assert(sock.indexOf('ListenStream=' + require(path.join(ROOT, 'app/phone')).SOCKET) >= 0 && /^SocketMode=0600$/m.test(sock), 'the socket is the one the app asks at, root\'s alone until sockgroup.js opens it to the app');
        assert.strictEqual(spec.config.loaderSocket, require(path.join(ROOT, 'app/phone')).SOCKET);
        assert.strictEqual(require(path.join(ROOT, 'loader/games')).APP, spec.id, 'the loader looks for another app');
        // the program that reads a gamepad: for the head unit's processor, needing no library of the head unit's
        // (tools/build-usbpipe.js builds it from loader/src/snes-usbpipe/main.go)
        // the program that plays a game's sound: for the head unit's processor, started by the head unit's own
        // loader of programs and asking for no version of a C library function (tools/build-sound.js builds it so)
        const asks = require(path.join(ROOT, 'tools/build-sound')).asks(path.join(ROOT, tool.path, 'snes-sound'));
        assert(c.files.some((f) => f.path === 'snes-sound' && f.mode === '0755') && c.files.some((f) => f.path === 'sound.js'), 'snes-sound and sound.js are installed');
        assert.deepStrictEqual([asks.loader, asks.versions], ['/lib/ld-linux-x86-64.so.2', []], 'snes-sound: build it with tools/build-sound.js');
        assert(asks.needs.every((n) => ['libc.so.6', 'libdl.so.2', 'libpthread.so.0'].indexOf(n) >= 0), 'snes-sound needs ' + asks.needs.join(', '));
        const pipe = fs.readFileSync(path.join(ROOT, tool.path, 'snes-usbpipe'));
        assert(c.files.some((f) => f.path === 'snes-usbpipe' && f.mode === '0755'), 'snes-usbpipe is installed as a program');
        assert(pipe.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && pipe[4] === 2 && pipe[5] === 1 && pipe.readUInt16LE(16) === 2 && pipe.readUInt16LE(18) === 0x3e, 'snes-usbpipe is a 64-bit x86 Linux program');
        const heads = pipe.readUInt32LE(32), headSize = pipe.readUInt16LE(54), headCount = pipe.readUInt16LE(56);   // (the program headers; none names a loader for libraries: type 3)
        for (let i = 0; i < headCount; i++) assert.notStrictEqual(pipe.readUInt32LE(heads + i * headSize), 3, 'snes-usbpipe needs libraries: build it with tools/build-usbpipe.js');
    });
    await check('store: the on-unit build passes with only the files an install downloads, and says what is wrong without the package', () => {
        const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'snes-store-'));
        const put = (rel) => {
            const from = path.join(ROOT, rel), to = path.join(copy, rel);
            if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to); fs.readdirSync(from).forEach((f) => put(rel + '/' + f)); return; }
            rel.split('/').slice(0, -1).reduce((d, part) => { const n = path.join(d, part); if (!fs.existsSync(n)) fs.mkdirSync(n); return n; }, copy);
            fs.writeFileSync(to, fs.readFileSync(from));
        };
        [entry.path].concat(entry.build.shared, [entry.build.node]).forEach(put);
        const args = entry.build.args.map((a) => a.replace(/\{id\}/g, entry.id).replace(/\{version\}/g, spec.version).replace(/\{dir\}/g, entry.path));
        const run = () => spawnSync(process.execPath, [entry.build.node].concat(args), { cwd: copy, encoding: 'utf8' });
        let r = run();
        assert(r.status === 0 && fs.statSync(path.join(copy, output)).isFile(), 'the build failed: ' + r.stdout + r.stderr);
        fs.unlinkSync(path.join(copy, output));
        r = run();
        assert(r.status === 1 && /build:store/.test(r.stderr), 'no clear failure without the package: ' + r.status + ' ' + r.stderr);
    });
    await check('app: one drawn screen, the game\'s, and every picture goes to it (the GPU renderer shows an app\'s first drawn screen only; a car\'s HMI took no picture for a second); a menu of four rows before it', () => {
        assert.deepStrictEqual(spec.screens.filter((s) => s.kind === 'canvas').map((s) => s.name), ['GAME']);
        const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
        const to = (main.match(/ui\.image\('[A-Z_]+'/g) || []).filter((v, i, all) => all.indexOf(v) === i);
        assert.deepStrictEqual(to, ['ui.image(\'GAME_GFX\''], 'a picture for another screen');
        assert(!/ui\.open\('(?!MAIN'|GAME'|SETTINGS')/.test(main), 'a screen opened that is not the menu, the game\'s, or the HMI\'s own of the settings');
        assert.deepStrictEqual(spec.screens[0].items.map((it) => it[1]), ['BTN_PLAY', 'BTN_GAMES', 'BTN_ADD', 'BTN_SET', 'MENU_INFO'], 'the menu\'s rows');
        assert(spec.screens[0].settings !== true && spec.settings.length > 0, 'the settings are not rows of the menu: the kit makes the HMI\'s own screen of them');
        // every row of the menu is answered, and the four touch buttons have a name on the tabs
        spec.screens[0].items.filter((it) => it[0] === 'button').forEach((it) => assert(main.indexOf('ui.onClick(\'' + it[1] + '\'') >= 0, it[1] + ' does nothing'));
        // the sound: the two interfaces of the head unit's audio manager, each only if the head unit has it, and a setting
        ['org.genivi.am.commandinterface.CommandControl', 'org.genivi.am.routinginterface.RoutingControlObserver'].forEach((i) => {
            assert(spec.signals[i] && spec.signals[i]._optional && spec.signals[i]._instances === '1' && spec.signals[i]._methods.length, i + ' is not asked for as an option');
        });
        assert(spec.settings.some((s) => s.key === 'sound' && s.type === 'bool' && s.default === true), 'no setting for the sound');
        const bar = spec.screens.find((s) => s.name === 'GAME').buttons.map((b) => b[0]);
        assert.deepStrictEqual(bar, ['BTN_SELECT', 'BTN_START', 'BTN_B', 'BTN_A']);
        bar.forEach((b) => assert(new RegExp(b + ': \'').test(main), b + ' has no name on the tabs'));
    });
    await check('app: every file of the app and the loader is code this Node reads (the head unit\'s is Node 8); every setting the app asks for is one it has', () => {
        const files = ['app', 'loader', 'tools', 'core', 'games', 'bakeoff'].reduce((all, d) => all.concat(fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.js$/.test(f)).map((f) => path.join(ROOT, d, f))), []);
        assert(files.length > 40, 'only ' + files.length + ' files found');
        files.forEach((f) => { const r = spawnSync(process.execPath, ['--check', f]); assert.strictEqual(r.status, 0, path.relative(ROOT, f) + ': ' + String(r.stderr).split('\n').slice(0, 5).join(' ')); });
        const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8'), keys = spec.settings.map((s) => s.key);
        const asked = (main.match(/settings\.get\('([A-Za-z]+)'\)/g) || []).map((m) => m.slice(14, -2)).filter((k, i, all) => all.indexOf(k) === i);
        asked.forEach((k) => assert(keys.indexOf(k) >= 0, 'main.js asks for the setting "' + k + '", which app.json does not have'));
        keys.forEach((k) => assert(asked.indexOf(k) >= 0, 'app.json has the setting "' + k + '", which main.js never asks for'));
        // how it starts: the gamepad on, by where its buttons are; the quick sound chip; every frame drawn until that is
        // too slow; high resolution as it is
        const dflt = {}; spec.settings.forEach((s) => { dflt[s.key] = s.default; });
        assert.deepStrictEqual([dflt.pad, dflt.padButtons, dflt.soundChip, dflt.draw, dflt.hires, dflt.press, dflt.turnR, dflt.turnL, dflt.parkedOnly, dflt.sound],
            [true, 'place', 'fast', 'auto', 'full', 'b', 'a', 'start', true, true]);
        spec.settings.filter((s) => s.type === 'choice').forEach((s) => assert(s.options.some((o) => o[0] === s.default), s.key + ': its first value is none of its choices'));
        // the two cores the setting "Sound chip" picks between are the two files the app has
        assert(/fast: 'snes\.wasm', plus: 'snes-plus\.wasm'/.test(main) && fs.existsSync(path.join(ROOT, 'app/snes.wasm')) && fs.existsSync(path.join(ROOT, 'app/snes-plus.wasm')));
        // the log's line about the frame's time, which is what a car is asked for first
        assert(/ms a frame \(worst /.test(main) && /skipped/.test(main) && /emulator compiled in/.test(fs.readFileSync(path.join(ROOT, 'app/snes-core.js'), 'utf8')), 'the frame time is not in the log');
        // its own names everywhere: nothing of the NES app's or its loader's
        const texts = files.filter((f) => !/bakeoff/.test(f)).concat([path.join(ROOT, 'app/app.json'), path.join(ROOT, 'loader/component.json'), path.join(ROOT, 'mgu-repo.json'),
            path.join(ROOT, 'loader/systemd/clucraft-snes-loader.socket'), path.join(ROOT, 'loader/systemd/clucraft-snes-loader.service')]);
        texts.forEach((f) => { const t = fs.readFileSync(f, 'utf8'); ['clucraft_nes', 'clucraft-nes-loader', 'NES_LOADER_SOCK', '"OAA6"'].forEach((w) => assert(t.replace(/SNES_LOADER_SOCK/g, '').indexOf(w) < 0, path.relative(ROOT, f) + ' has "' + w + '" in it')); });
        assert.strictEqual(spec.loggingId, 'OACA');
        assert(loader.service.PORT === undefined || loader.service.PORT === 8494);
        assert(/const PORT = 8494;/.test(fs.readFileSync(path.join(ROOT, 'loader/service.js'), 'utf8')), 'the loader\'s port is not its own (8493 is the NES game loader\'s)');
    });

    console.log(failed ? failed + ' failed' : 'snes: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
