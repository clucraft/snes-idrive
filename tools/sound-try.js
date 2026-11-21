'use strict';
/**
 * A game's sound as the car's sound device would get it, to listen to on a PC before it goes on a car:
 *
 *   node tools/sound-try.js [game.sfc] [--seconds 12] [--plus] [--hold B] [--out file.wav]
 *
 * Runs the game in the app's core (app/snes.wasm; --plus: app/snes-plus.wasm) at the console's pace and
 * hands each frame's sound, as it is made, to the loader's own player (loader/snes-sound), which brings the
 * core's 32040 or so samples a second to the device's 48000 and keeps pace with it. In place of a sound
 * device the player writes a file (its SNES_SOUND_OUT), and that is saved as a .wav: .cache/sound/<game>.wav.
 * Without a game it is Pad Test, which beeps at 1000 Hz as each second of its clock begins: the beeps in the
 * .wav are then measured (how far apart, what pitch), which says whether the rate is right all the way.
 *
 * The player is a Linux program: on Linux it runs here, on Windows inside WSL (it needs no sound library to
 * write a file).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Snes, BTN } = require('../app/snes-core');

const ROOT = path.resolve(__dirname, '..');
const a = process.argv.slice(2);
const opt = (name, dflt) => { const i = a.indexOf(name); return i >= 0 ? a.splice(i, 2)[1] : dflt; };
const seconds = +opt('--seconds', 12), hold = String(opt('--hold', '')).toUpperCase(), outArg = opt('--out', null);
const plus = a.indexOf('--plus') >= 0 ? !!a.splice(a.indexOf('--plus'), 1) : false;
const game = a[0] || path.join(ROOT, 'app', 'games', 'Pad_Test.sfc');
const out = path.resolve(outArg || path.join(ROOT, '.cache', 'sound', path.basename(game).replace(/\.[^.]+$/, '') + (plus ? '-plus' : '') + '.wav'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const mono = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };
const mkdirp = (d) => { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d); } };
/** a path of this computer as the player sees it (inside WSL on Windows) */
const seen = (p) => (process.platform === 'win32' ? '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/') : p);

function wav(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}
/** where the sound is loud: [{ at: seconds, for: seconds, hz }] */
function beeps(pcm, rate) {
    const n = pcm.length >> 2, list = [];
    // (the pitch: the whole cycles between the first and the last time the sound goes up through its middle)
    let start = -1, last = -1, cycles = 0, below = true, up0 = -1, up1 = -1;
    for (let i = 0; i < n; i++) {
        const v = pcm.readInt16LE(i * 4);
        if (Math.abs(v) > 1500) { if (start < 0) { start = i; cycles = 0; below = v < 0; up0 = up1 = -1; } last = i; }
        if (start >= 0) { if (below && v > 500) { if (up0 < 0) up0 = i; else cycles++; up1 = i; below = false; } else if (v < -500) below = true; }
        if (start >= 0 && i - last > rate / 200) { const len = (last - start) / rate; if (len > 0.02) list.push({ at: start / rate, for: len, hz: up1 > up0 ? cycles * rate / (up1 - up0) : 0 }); start = -1; }
    }
    return list;
}

(async () => {
    mkdirp(path.dirname(out));
    const raw = out.replace(/\.wav$/, '') + '.raw';
    try { fs.unlinkSync(raw); } catch (e) { /* none */ }
    const snes = new Snes({ wasm: path.join(ROOT, 'app', plus ? 'snes-plus.wasm' : 'snes.wasm'), log: quiet });
    await snes.compile();
    if (!snes.load(fs.readFileSync(game))) throw new Error(game + ' did not load');
    const rate = snes.sampleRate, ld = '/lib64/ld-linux-x86-64.so.2', player = path.join(ROOT, 'loader', 'snes-sound');
    const env = ['SNES_SOUND_OUT=file:' + seen(raw), 'SNES_SOUND_AS_ROOT=1'];
    const cmd = process.platform === 'win32' ? ['wsl', '-e', 'env'].concat(env, [ld, seen(player), 'a-device', String(rate)]) : ['env'].concat(env, [ld, player, 'a-device', String(rate)]);
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    let said = '';
    child.stdout.on('data', (d) => { said += d; });
    child.stdin.on('error', () => {});
    // (the game starts once the player is there, as the app sends no sound before the loader says it may: what
    // waits for a player that is late is dropped by it, and it plays a little faster for a while to catch up)
    await new Promise((resolve) => { const t = setInterval(() => { if (/"open"|"error"/.test(said) || child.exitCode !== null) { clearInterval(t); resolve(); } }, 20); });
    console.log('sound-try: ' + path.basename(game) + ', the core makes ' + rate + ' samples a second; ' + seconds + ' s through loader/snes-sound' + (hold ? ', ' + hold + ' held' : ''));
    const total = Math.round(seconds * 60), t0 = mono();
    let done = 0, sent = 0;
    await new Promise((resolve) => {
        const t = setInterval(() => {
            const due = Math.min(total, Math.floor((mono() - t0) * 60 / 1000));
            for (; done < due; done++) {
                snes.setPad(0, BTN[hold] || 0);
                snes.run(false);
                const au = snes.audio();
                if (au) { child.stdin.write(Buffer.from(au.bytes)); sent += au.frames; }
            }
            if (done >= total) { clearInterval(t); setTimeout(() => { child.stdin.end(); }, 200); }
        }, 4);
        child.on('exit', resolve);
    });
    const events = said.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).ev; } catch (e) { return l; } });
    if (!fs.existsSync(raw)) throw new Error('the player wrote nothing (it said: ' + events.join(', ') + ')');
    const pcm = fs.readFileSync(raw);
    fs.writeFileSync(out, wav(pcm, 48000));
    fs.unlinkSync(raw);
    console.log('sound-try: ' + sent + ' samples in (' + (sent / rate).toFixed(2) + ' s at ' + rate + '), ' + (pcm.length >> 2) + ' out (' + ((pcm.length >> 2) / 48000).toFixed(2) + ' s at 48000); the player said: ' + events.filter((e, i, all) => all.indexOf(e) === i).join(', '));
    const b = beeps(pcm, 48000);
    if (/Pad_Test/.test(game) && !hold) {
        const gaps = b.slice(1).map((x, i) => x.at - b[i].at);
        console.log('sound-try: ' + b.length + ' beeps; apart ' + gaps.map((g) => g.toFixed(3)).join(' ') + ' s (1.000 is right); pitch ' + b.map((x) => x.hz.toFixed(0)).join(' ') + ' Hz (1000 is right); each ' + b.map((x) => (x.for * 1000).toFixed(0)).join(' ') + ' ms');
    } else console.log('sound-try: loud for ' + b.reduce((s, x) => s + x.for, 0).toFixed(2) + ' s of it' + (b.length && b.length < 12 ? ': ' + b.map((x) => x.at.toFixed(2) + ' s for ' + x.for.toFixed(2) + ' s at ' + x.hz.toFixed(0) + ' Hz').join('; ') : ''));
    console.log('sound-try: listen to ' + path.relative(process.cwd(), out));
})().catch((e) => { console.error('sound-try: ' + e.message); process.exit(1); });
