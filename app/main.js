'use strict';
/**
 * SNES - Super Nintendo games on the iDrive, for when you're parked (setting "Parked only", on by default).
 *
 * The emulator is the libretro core snes9x2005 (Snes9x 1.43; non-commercial use only: LICENSE and NOTICE
 * in this folder) compiled to WebAssembly (core/build.js) and run here at the console's 60 frames a
 * second (snes-core.js). There are two builds of it, and the setting "Sound chip" picks: snes.wasm with the
 * core's own sound chip emulation, snes-plus.wasm with blargg's, which is truer and takes longer a frame.
 * Each frame is the console's own picture, 256 x 224 for nearly every game, handed to the GPU renderer as a
 * pixel image and shown three times as big, pixel for pixel. Its sound goes to the SNES game loader, which
 * plays it into the head unit's sound mixer (sound.js), and the head unit's audio manager is asked to put that
 * on the speakers (caraudio.js): setting "Sound".
 *
 * Screens:
 *   MAIN  the main menu, an HMI list of four: Continue, Games, Add games from a phone, Settings. The last
 *         opens the HMI's own screen of the settings (SETTINGS, the kit's): a finger works on its rows,
 *         so they can be reached whatever steers the drawn screen.
 *   GAME  the one drawn screen ("chrome": false). It shows the game on the whole screen, or, while no
 *         game is on it, three pages under a row of tabs (tabs.js): Games, the list to pick from; Add
 *         games, a QR code for the page the SNES game loader opens on the car Wi-Fi (phone.js, qr.js;
 *         loader/ in the repository), and what came in; Settings. BACK (the HMI's own) returns to the
 *         menu. All of it is on this one screen because the GPU renderer draws one screen of an app, and
 *         on a car a second drawn screen stayed empty (the NES app's finding). The tabs are steered by the
 *         controller, a USB gamepad, and the four buttons on the touchscreen: a finger on the page itself
 *         does not reach an app that draws pixel pictures (kit renderd.js: claim).
 *
 * Games are .sfc and .smc files (library.js): one comes with the app (app/games/); your own are in
 * <the app's data folder>/roms/ on the head unit (copied there, or sent from a phone), in a folder
 * "snes" on a USB stick, or packed into the app from app/roms/ by a build on a PC.
 *
 * Controls: a USB gamepad is how this is played (setting "USB gamepad", on at first; pad.js; the SNES game
 * loader reads it): an Xbox pad's buttons are the SNES pad's twelve, by where they are, and both sticks
 * pressed in, or the Xbox button, leave the game for the list of games. The iDrive controller (controls.js)
 * gives one direction at a time, one held button and taps: push for the D-pad, press and the two turn
 * directions for buttons the settings name; Select, Start, B and A are also buttons on the touchscreen,
 * beside the picture. That steers the tabs and is enough for a slow game, and for little else.
 *
 * The game runs only while GAME is on screen - and, with "Parked only" (the default), while the car
 * stands. Whenever it stops (BACK, MENU, a popup or call, driving off, the app closing) the console's
 * state and the cartridge's battery memory are saved, and Continue carries on from there.
 *
 * How fast it runs is the question this app's first versions are there to answer, so it says: beside the
 * picture, and in the log every ten seconds a game runs (the one thing that can be read off a car with cat):
 *   snes: 600 frames in 10.0 s, 1.84 ms a frame (worst 3.10), drawn 600 (2.01 ms), not drawn 0, skipped 0, late 2; picture 256x224; core snes.wasm
 * (and "; a state of 529140 bytes saved in 3.1 ms" behind it when the game was saved in those ten seconds)
 * (and behind "late": "; a call 2.40 ms, with a picture 2.61 ms", which is the whole of what this app does each
 * time the screen asks for a frame: the emulator's frames and the picture handed to the renderer).
 * A frame's time is the emulator's alone (pad in, one frame, its sound taken). Frames that are run to catch up
 * are not drawn, and with the setting "Picture" neither is every second one: "not drawn". "Skipped" are frames
 * of the game's clock that were dropped after a stall; "late" counts calls more than half a frame behind.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, setImage } = require('./kit/record');
const { HMI7 } = require('./kit/display');
const Parked = require('./kit/parked');
const { Snes, romInfo } = require('./snes-core');
const { Controls } = require('./controls');
const { Library, mkdirp, usbFolders } = require('./library');
const { Phone } = require('./phone');
const { Pad, PAD, wantsOut } = require('./pad');
const { Tabs } = require('./tabs');
const { Sound } = require('./sound');
const { createCarAudio } = require('./caraudio');
const { qr } = require('./qr');

const W = 1600, H = 520, IMG = 1;
const BAR = ['BTN_SELECT', 'BTN_START', 'BTN_B', 'BTN_A'];
const MAX_STEP = 6;                                 // frames run at once at most, to catch up
const KEEP_MS = 30000;                              // while playing: battery memory and state saved this often
const LOG_MS = 10000;                               // while playing: the line about the frame's time this often
const CORES = { fast: 'snes.wasm', plus: 'snes-plus.wasm' };   // setting "Sound chip"
const HELD_MS = 400, AGAIN_MS = 90;                 // a gamepad's D-pad held on the tabs: it moves on after, and then every
const BAR_TABS = { BTN_SELECT: 'Tab', BTN_START: 'Up', BTN_B: 'Down', BTN_A: 'OK' };   // the touch buttons while the tabs show
const NAMES = { a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'Start', select: 'Select' };
const C = { bg: '#000000', text: '#e8eaed', dim: '#8c939c', key: '#ffffff', btn: '#1a1e24', edge: '#4a525c', lit: '#c8102e', good: '#7ddc8a', bad: '#ff8f8f', paper: '#ffffff', ink: '#000000' };
/** milliseconds on a monotonic clock (the wall clock can jump: GPS / network time sync) */
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* ---------- parked only (setting, on by default): the game waits while the car drives ---------- */
        const parked = Parked.watch(ctx, log);
        const driving = () => settings.get('parkedOnly') !== false && parked.moving();

        /* ---------- the games ---------- */
        const romDir = path.join(ctx.dataDir, 'roms');
        try { mkdirp(romDir); } catch (e) { log.warn('snes: ' + romDir + ': ' + e.message); }
        const config = ctx.spec.config || {};
        // games on a USB stick, in a folder "snes" at its top: there while the stick is in
        let usbNow = null;
        const usb = () => {
            const u = usbFolders(config.usbRoots || [], ['snes', 'SNES', 'Snes']);
            const now = u.dirs.concat(u.errors).join(' | ');
            if (now !== usbNow) {
                usbNow = now;
                log.info('snes: USB sticks: ' + (u.dirs.length ? 'games in ' + u.dirs.join(', ') : 'no folder "snes" on one') + (u.errors.length ? '; cannot read ' + u.errors.join(', ') : ''));
            }
            return u.dirs;
        };
        const lib = new Library({
            packs: [path.join(__dirname, 'games.pack'), path.join(__dirname, 'roms.pack')],
            // (SNES_ROMS: a folder of games for the emulator on a PC, tools/emu.js)
            dirs: [romDir].concat(config.romDirs || [], process.env.SNES_ROMS ? [process.env.SNES_ROMS] : []), more: usb, dataDir: ctx.dataDir, log,
        });
        // (libRev counts up when the games found are others than before: the drawn list follows it)
        let libRev = 0, libKey = '';
        const scan = () => { lib.scan(); const k = lib.games.map((g) => g.id).join('/'); if (k !== libKey) { libKey = k; libRev++; } };
        scan();
        log.info('snes: ' + lib.games.length + ' game(s); more go on a USB stick (folder "snes") or into ' + romDir);

        /* ---------- the console ---------- */
        // one of the two cores at a time (setting "Sound chip"): the other's memory is given back when a game changes over
        const chip = () => (settings.get('soundChip') === 'plus' ? 'plus' : 'fast');
        const onDead = () => { err = (game ? game.title : 'The game') + ' stopped: the emulator crashed'; game = null; frames = 0; if (view === 'play') show('games'); menu(); };
        const made = {};
        const core = (name) => {
            if (!made[name]) { made[name] = new Snes({ wasm: path.join(__dirname, CORES[name]), log }); made[name].onDead = onDead; made[name].name = name; }
            return made[name];
        };
        let snes = core(chip());
        let game = null;                 // the game in the console (a library entry)
        let err = null;                  // what went wrong, for the menu
        let starting = false, going = false;
        let view = 'games';              // what the game's screen shows: 'play' (the game), or a page of the tabs: 'games', 'add', 'settings'
        let frames = 0;                  // pictures of this game so far
        let keptSram = null, keptT = 0;
        let saved = null;                // the last save of a state: { bytes, ms }, until the log has it
        const pic = { px: null, w: 0, h: 0 };
        // compiled in the background from the start (a few seconds on the head unit): ready by the time a game is picked
        snes.compile().catch((e) => { err = 'The emulator did not start: ' + (e.message || e); log.error('snes: compile', e); menu(); });

        function applyOptions() {
            snes.setVar('snes9x_2005_reduce_sprite_flicker', settings.get('flicker') === true ? 'enabled' : 'disabled');
            // A picture with twice the pixels (512 wide, 448 high: a few games' menus and text) as it is, each of its
            // pixels one and a half of the screen's, or shrunk to the console's own size. As it is the text is sharp
            // and its pixels are a little uneven; shrunk it is blurred, and a quarter of the bytes to hand over.
            // (Looked at both in the emulator: as it is reads far better, so that is how it starts.)
            snes.setShrink(settings.get('hires') === 'shrink');
        }
        /** the state file's mark for the core in use ('' for the first: library.js) */
        const tag = () => (snes.name === 'plus' ? 'plus' : '');

        /** save what the game has: its battery memory (when it changed) and, with state, where it stands */
        function keep(state) {
            if (!game || !snes.loaded) return;
            const t = mono(), sram = snes.sram();
            if (sram && !(keptSram && keptSram.equals(sram)) && lib.setSram(game, sram)) keptSram = sram;
            // (a state is half a megabyte with this core: what making and writing one takes goes into the log's line)
            if (state && frames) { const st = snes.saveState(); if (st && lib.setState(game, st, tag())) saved = { bytes: st.length, ms: mono() - t }; }
            keptT = Date.now();
        }

        /** Put a game into the console and show it. fresh: from power-on, not from where it was left. */
        async function play(g, fresh) {
            if (starting || !g) return;
            if (driving()) { menu(); return; }
            starting = true; err = null;
            try {
                // the game in the console is saved first (a game restarted keeps its battery memory, not its state)
                if (game && snes.loaded) keep(!(fresh && game.id === g.id));
                // the other core was chosen meanwhile: this one's game and memory go
                if (snes.name !== chip()) { snes.close(); game = null; frames = 0; snes = core(chip()); }
                if (!snes.ready) { put('MENU_INFO', 'Starting the emulator...'); await snes.compile(); }
                applyOptions();
                const rom = lib.read(g), info = rom && romInfo(rom), t0 = mono();
                if (!rom || !snes.load(rom)) {
                    game = null; frames = 0;
                    err = g.title + ': not a game this emulator can run';
                    log.warn('snes: ' + g.file + ' did not load');
                    return;
                }
                game = g; frames = 0; pic.w = pic.h = 0;
                // the battery memory saved last time goes back in; it is written again only once the game changes it
                keptSram = lib.sram(g);
                if (!(keptSram && snes.setSram(keptSram))) keptSram = snes.sram();
                let resumed = false;
                if (fresh) lib.dropState(g);
                else if (settings.get('resume') !== false) {
                    const st = lib.state(g, tag());
                    resumed = !!st && snes.loadState(st);
                    if (st && !resumed) log.warn('snes: ' + g.id + ': its saved state did not load, starting from power-on');
                }
                lib.setLast(g);
                log.info('snes: ' + g.file + (resumed ? ' (carrying on)' : ' (from power-on)') + ': ' + info.mapping + ', "' + info.title + '", cartridge type 0x' + info.chip.toString(16) + ', ' + rom.length + ' bytes; loaded in ' +
                    (mono() - t0).toFixed(0) + ' ms, ' + (snes.fps || 60).toFixed(2) + ' fps, sound ' + snes.sampleRate + ' Hz, core ' + CORES[snes.name]);
                show('play');
                if (!ui.isVisible('GAME')) await ui.open('GAME');
            } catch (e) {
                err = 'The emulator did not start: ' + (e.message || e);
                log.error('snes: play', e);
            } finally { starting = false; menu(); }
        }

        /* ---------- main menu ---------- */
        // a row's text and whether it shows go to the HMI only when they change (and all of them again
        // each time the menu comes on screen)
        const sent = new Map();
        const put = (name, text) => { if (sent.get('t' + name) !== text) { sent.set('t' + name, text); ui.text(name, text); } };
        const shownRow = (name, on) => { if (sent.get('v' + name) !== on) { sent.set('v' + name, on); ui.visible(name, on); } };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { sent.clear(); menu(); } });
        function menu() {
            const cur = game || lib.last();
            let info;
            if (err) info = err;
            else if (driving()) info = 'Parked only - the game waits while you drive (Settings: Parked only)';
            else if (!lib.games.length) info = 'No games: put .sfc and .smc files in a folder "snes" on a USB stick, or copy them to ' + romDir;
            else info = lib.games.length + (lib.games.length === 1 ? ' game' : ' games') + '. In a game, BACK returns here and saves';
            put('BTN_PLAY', cur ? 'Continue: ' + cur.title : 'Continue');
            shownRow('BTN_PLAY', !!cur);
            put('BTN_GAMES', 'Games (' + lib.games.length + ')');
            put('MENU_INFO', info);
        }
        /** what the game's screen shows from now on: the game ('play'), or a page of the tabs */
        function show(v) {
            if (v === view) return;
            // (games sent from a phone are in the list once the page is left)
            if (view === 'add') { phone.close(); scan(); }
            view = v;
            pageKey = null;
            if (v !== 'play' && tabs.name !== v) tabs.open(v);
            sync();
        }
        /** a page of the tabs, from the menu */
        const page = (v) => { show(v); tabs.open(v); return ui.isVisible('GAME') ? null : ui.open('GAME'); };
        /** the game the console already holds goes back on screen as it is; any other is put in */
        const pick = (g) => {
            if (driving()) { menu(); return null; }
            if (!(g && game && snes.loaded && game.id === g.id)) return play(g);
            show('play');
            return ui.isVisible('GAME') ? null : ui.open('GAME');
        };
        ui.onClick('BTN_PLAY', () => pick(game || lib.last()));
        ui.onClick('BTN_GAMES', () => page('games'));
        ui.onClick('BTN_ADD', () => page('add'));
        // (the HMI's own screen of them: the drawn one is the tab "Settings")
        ui.onClick('BTN_SET', () => ui.open('SETTINGS'));
        menu();
        // (games copied over while the app runs show up; the texts follow the car standing or driving)
        setInterval(() => { if ((ui.isVisible('MAIN') || (ui.isVisible('GAME') && view === 'games')) && !starting) { if (!going) scan(); menu(); } }, 3000);

        /* ---------- controls ---------- */
        // (while the tabs show, the same controller and touch buttons steer those: nav)
        const ctl = new Controls({
            log, press: () => settings.get('press'), turnR: () => settings.get('turnR'), turnL: () => settings.get('turnL'),
            nav: (ev) => { if (view !== 'play') tabs.input(ev); },
        });
        // the controller events the HMI didn't get while the game holds the controller (the renderer
        // hands them on from mgu-inputgate.so in the HMI)
        let ccuT = 0;
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => { ccuT = Date.now(); ctl.raw(v, true); });
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            // (while the game holds the controller, the same events come from the renderer too: that
            // copy wins, this one is for when it doesn't come)
            statusRotaryEncoderState: (v) => { if (Date.now() - ccuT > 1000) ctl.raw(v, false); },
        }, log).then((s) => log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        BAR.forEach((b) => ui.onClick(b, () => { if (settings.get('touch') !== false) ctl.bar(b); }));
        // a USB gamepad (setting "USB gamepad"): the SNES game loader reads it while a game runs (pad.js)
        // On the tabs its D-pad moves as the controller's pushes do, A chooses, LB and RB go to the tab to the
        // left and right. In a game every one of the SNES pad's buttons is the game's, L and R too: both sticks
        // pressed in together, or the Xbox button, leave it for the list of games.
        let padWas = 0, again = null;            // the pad's buttons before; a direction held: { ev, bit, at: when it moves on }
        const padSteer = (b) => {
            const down = b & ~padWas;
            padWas = b;
            if (view === 'play') {
                if (wantsOut(b) && !wantsOut(b & ~down)) show('games');
                return;
            }
            if (down & PAD.L) tabs.input({ tab: -1 });
            if (down & PAD.R) tabs.input({ tab: 1 });
            [[PAD.UP, 'N'], [PAD.DOWN, 'S'], [PAD.LEFT, 'W'], [PAD.RIGHT, 'E']].forEach((d) => {
                if (!(down & d[0])) return;
                tabs.input({ push: d[1] });
                again = d[1] === 'N' || d[1] === 'S' ? { ev: { push: d[1] }, bit: d[0], at: Date.now() + HELD_MS } : null;
            });
            if (again && !(b & again.bit)) again = null;
            if (down & (PAD.A | PAD.START)) tabs.input({ press: true });
        };
        const pad = new Pad({ socket: process.env.SNES_LOADER_SOCK || config.loaderSocket, log, onMask: (m) => ctl.setExternal(m), onButtons: padSteer, letters: () => settings.get('padButtons') === 'letter' });
        // The game's sound (setting "Sound", on at first), while it runs: the SNES game loader plays it (sound.js),
        // and once its player is up the head unit's audio manager is asked for the speakers (caraudio.js; not
        // before: they would be taken from the radio for nothing). On a PC there is no audio manager to ask.
        const sound = new Sound({ socket: process.env.SNES_LOADER_SOCK || config.loaderSocket, log });
        const speakers = ctx.signals.hasNative && ctx.signals.hasNative() ? createCarAudio(ctx.signals, log, path.join(ctx.dataDir, 'speakers.json')) : null;
        const loud = () => going && settings.get('sound') !== false;
        /** the sound's state in a few words, for the panel beside the game; null with the setting off */
        const soundSays = () => {
            if (settings.get('sound') === false) return null;
            const s = sound.state, at = speakers ? speakers.state() : null;
            if (s.step === 'missing') return 'Needs the SNES game loader';
            if (s.step === 'failed') return s.error || 'Not here';
            if (s.step !== 'on') return 'Starting...';
            if (s.player === 'busy') return 'Another app has the sound device';
            if (s.player === 'error') return s.error || 'Cannot be played';
            if (at && at.error) return 'No speakers: ' + at.error;
            return s.player === 'playing' ? 'On the car\'s speakers' : 'Waiting for the speakers';
        };

        /* ---------- run while the game screen is up; save when it stops ---------- */
        const shown = () => ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
        let lastT = 0, acc = 0;
        let held = null;
        function sync() {
            const up = shown();
            const go = view === 'play' && !!game && snes.loaded && up && !driving();
            if (go !== going) {
                going = go;
                ctl.enable(go);
                if (go) { lastT = 0; acc = 0; keptT = Date.now(); stat.since = mono(); half = settings.get('draw') === 'half'; } else { keep(true); report(); menu(); }
                // driving off with the game on screen: the list of games, which says why it waits
                if (!go && view === 'play' && up && driving()) { log.info('car moving: game paused'); show('games'); }
            }
            // the controller to this screen alone while it shows, the game or the tabs (the HMI's pull-down /
            // back on a push stay away); BACK and MENU still work. Needs mgu-inputgate.so (deploy-car.sh)
            if (up !== held) { held = up; if (ctx.controller) ctx.controller.grab(up); }
            ctl.navigate(up && view !== 'play');
            if (going) { applyOptions(); if (Date.now() - keptT > KEEP_MS) keep(true); }
            // a gamepad is read while the screen shows: it steers the tabs too
            if (up && settings.get('pad') !== false) pad.start(); else { pad.stop(); padWas = 0; again = null; }
            if (loud()) sound.start(snes.sampleRate || 32040); else sound.stop();
            if (speakers) speakers.want(loud() && sound.state.step === 'on' && ['open', 'playing', 'waiting'].indexOf(sound.state.player) >= 0);
        }
        setInterval(sync, 200);
        if (ui.onFocus) ui.onFocus(() => sync());
        ui.onVisible(() => sync());
        process.on('exit', () => { try { if (going) keep(true); } catch (e) { /* exiting */ } });

        /* ---------- how long a frame takes, and what is drawn ---------- */
        const stat = { n: 0, ms: 0, worst: 0, drawn: 0, drawnMs: 0, skipped: 0, late: 0, since: 0, calls: 0, callMs: 0, pictures: 0, pictureMs: 0 };
        let drewNow = false;             // the call in hand drew a picture
        let said = null;                 // the last ten seconds, for the panel beside the picture
        let half = false, tick = 0;      // every second frame is not drawn (setting "Picture": always, or while it is too slow)
        function report() {
            if (stat.n) {
                const secs = (mono() - stat.since) / 1000, mean = stat.ms / stat.n, notDrawn = stat.n - stat.drawn;
                said = { mean, worst: stat.worst, skipped: stat.skipped, half, fps: stat.drawn / Math.max(0.001, secs) };
                log.info('snes: ' + stat.n + ' frames in ' + secs.toFixed(1) + ' s, ' + mean.toFixed(2) + ' ms a frame (worst ' + stat.worst.toFixed(2) + '), drawn ' + stat.drawn +
                    (stat.drawn ? ' (' + (stat.drawnMs / stat.drawn).toFixed(2) + ' ms)' : '') + ', not drawn ' + notDrawn + ', skipped ' + stat.skipped + ', late ' + stat.late +
                    '; a call ' + (stat.calls ? (stat.callMs / stat.calls).toFixed(2) : '-') + ' ms, with a picture ' + (stat.pictures ? (stat.pictureMs / stat.pictures).toFixed(2) : '-') + ' ms' +
                    '; picture ' + pic.w + 'x' + pic.h + '; core ' + CORES[snes.name] + (saved ? '; a state of ' + saved.bytes + ' bytes saved in ' + saved.ms.toFixed(1) + ' ms' : ''));
                saved = null;
                // Setting "Picture", automatic: every second frame while a call of this app's (the emulator's frames
                // and the picture handed over) takes over half a frame's time, every one again once a call with a
                // picture takes under a third of it. Frames skipped do not count: they tell that the app was called
                // late, which drawing less does not mend.
                if (settings.get('draw') === 'auto') {
                    const frameMs = 1000 / (snes.fps > 40 && snes.fps < 75 ? Math.round(snes.fps) : 60);
                    const call = stat.calls ? stat.callMs / stat.calls : mean, withPicture = stat.pictures ? stat.pictureMs / stat.pictures : call;
                    const now = half ? withPicture > frameMs / 3 : call > frameMs / 2;
                    if (now !== half) { half = now; log.info('snes: ' + (half ? 'too slow to draw every frame: every second one from now' : 'fast enough again: every frame is drawn')); }
                } else half = settings.get('draw') === 'half';
            }
            stat.n = stat.ms = stat.worst = stat.drawn = stat.drawnMs = stat.skipped = stat.late = stat.calls = stat.callMs = stat.pictures = stat.pictureMs = 0;
            stat.since = mono();
        }

        /** run the console up to now: one frame per 1/60 s (1/50 s for a PAL game), a few at once after a late call */
        function advance() {
            const now = mono(), frameMs = 1000 / (snes.fps > 40 && snes.fps < 75 ? Math.round(snes.fps) : 60);
            let dt = lastT ? now - lastT : frameMs;
            lastT = now;
            if (!(dt > 0) || dt > 500) dt = frameMs;            // after a stall: no catching up
            if (dt > frameMs * 1.5) stat.late++;
            acc += dt;
            let n = Math.round(acc / frameMs);
            if (n > MAX_STEP) { stat.skipped += n - MAX_STEP; n = MAX_STEP; acc = 0; } else acc -= n * frameMs;
            let drew = false;
            for (let i = 0; i < n && snes.loaded; i++) {
                // of frames run at once only the last is seen, so only that one is drawn; and of those, every second with "half"
                const draw = i === n - 1 && !(half && (tick++ & 1));
                const t = mono();
                snes.setPad(0, ctl.mask());
                const got = snes.run(draw);
                if (sound.ready) { const a = snes.audio(); if (a) sound.write(a.bytes); }
                const ms = mono() - t;
                stat.n++; stat.ms += ms; if (ms > stat.worst) stat.worst = ms;
                if (got) { drew = true; stat.drawn++; stat.drawnMs += ms; }
            }
            if (now - stat.since > LOG_MS) report();
            drewNow = drew;
            if (!drew) return;
            const f = snes.frame();
            if (!f) return;
            // a copy: the core's picture is only valid until it runs again
            if (!pic.px || pic.px.length !== f.px.length) pic.px = new Uint8Array(f.px.length);
            pic.px.set(f.px); pic.w = f.w; pic.h = f.h;
            setImage(IMG, pic.w, pic.h, pic.px);
            frames++;
        }

        /* ---------- drawing ---------- */
        const fit = (r, s, size, font, max) => {
            if (r.textWidth(s, size, { font, literal: true }) <= max) return s;
            while (s.length > 1 && r.textWidth(s + '...', size, { font, literal: true }) > max) s = s.slice(0, -1);
            return s.trim() + '...';
        };
        /** the panel left of the picture: the game's name, what the controller does, the touch buttons */
        function panel(r, right, btns) {
            const x = HMI7.btn.x, w = right - x - 40;
            r.text(fit(r, game.title, 46, 'bold', w), x, 92, 46, C.text, { font: 'bold', literal: true });
            const rows = [['Push', 'D-pad'], ['Press', NAMES[settings.get('press')] || 'A'],
                ['Turn right', NAMES[settings.get('turnR')] || null], ['Turn left', NAMES[settings.get('turnL')] || null],
                ['BACK', 'Menu (the game is saved)'], ['Sticks in', pad.name ? 'The list of games' : null], ['Sound', soundSays()],
                ['A frame', said ? said.mean.toFixed(1) + ' ms, worst ' + said.worst.toFixed(1) + (said.half ? '; every 2nd drawn' : '') + (said.skipped ? '; ' + said.skipped + ' skipped' : '') : 'measuring...']].filter((q) => q[1]);
            rows.forEach((q, i) => {
                const y = 172 + i * 50;
                r.text(q[0], x, y, 30, C.key, { font: 'bold' });
                r.text(fit(r, String(q[1]), 30, null, w - 230), x + 230, y, 30, C.dim, { literal: true });
            });
            const top = HMI7.barTop + 10, bh = r.h - top - 10;
            btns.forEach((b) => {
                const bx = b.x + 6, bw = Math.min(b.x + b.w, right) - b.x - 12, lit = ctl.lit(b.id);
                if (bw < 60) return;
                r.roundRect(bx, top, bw, bh, 16, lit > 0 ? C.lit : C.btn);
                r.strokeRoundRect(bx, top, bw, bh, 16, 2, C.edge);
                r.text(String(b.label).toUpperCase(), bx + bw / 2, top + bh / 2 + 15, 40, C.text, { align: 'center', font: 'bold' });
            });
        }
        let sr = null;
        function render() {
            if (view !== 'play') return tabsFrame();
            const t0 = mono();
            drewNow = false;
            if (going) advance();
            const stop = err ? 'The game stopped' : !game ? 'No game: BACK for the menu' : !frames ? 'Loading...' : null;
            const cv = ctx.canvas(W, H);
            const pl = cv.place;
            // The console's picture is 256 wide and 224 (or 239) high. A high-resolution frame, when the setting has
            // them as they are, has twice as many pixels one way or both: it is shown in the same place, each of its
            // pixels half as big (not a whole number of the screen's: 1.5).
            const bw = pic.w > 256 ? pic.w / 2 : pic.w, bh = pic.h > 240 ? pic.h / 2 : pic.h;
            if (pl && pl.full) {
                // screen pixels: the whole display is ours, but for the HMI's back arrow column
                cv.clear([0, 0, 0, 0]);
                if (!sr || sr.w !== pl.w || sr.h !== pl.h) sr = new Recorder(pl.w, pl.h);
                sr.reset();
                const id7 = pl.w === HMI7.screen.w && pl.h === HMI7.screen.h;
                const left = id7 ? HMI7.left : 0, colEnd = id7 ? HMI7.colEnd : 0;
                sr.fillRect(left, 0, pl.w - left, pl.h, C.bg);
                if (left) sr.fillRect(0, colEnd, left, pl.h - colEnd, C.bg);
                if (stop) sr.text(stop, pl.w / 2, pl.h / 2 + 10, 30, C.text, { align: 'center', font: 'bold' });
                else {
                    // whole screen pixels per console pixel: 3 on the 720 lines of iDrive 7
                    const k = Math.max(1, Math.floor(Math.min(pl.h / bh, (pl.w - left) / bw)));
                    const pw = bw * k, ph = bh * k, py = Math.round((pl.h - ph) / 2);
                    // touch buttons: where the HMI's own (hidden) bar buttons are, so the picture goes to the right
                    const btns = id7 && settings.get('touch') !== false ? ctx.display.buttons() : [];
                    const side = btns.length > 0 && btns[btns.length - 1].x + btns[btns.length - 1].w <= pl.w - pw + 40;
                    const px = side ? pl.w - pw : left + Math.round((pl.w - left - pw) / 2);
                    sr.image(IMG, px, py, pw, ph);
                    if (side) panel(sr, px, btns);
                }
                cv.xf(1, 0, 0).append(sr).xf();
            } else {
                // software / standard layout: the game in the app's image area, twice as big
                cv.clear(C.bg);
                if (stop) cv.text(stop, W / 2, H / 2, 28, C.text, { align: 'center', font: 'bold' });
                else {
                    const k = Math.max(1, Math.floor(H / bh));
                    cv.image(IMG, Math.round((W - bw * k) / 2), Math.round((H - bh * k) / 2), bw * k, bh * k);
                }
            }
            const handed = ui.image('GAME_GFX', cv);
            // what the whole call took, this app's part of it: the emulator's frames, and the picture on its way
            if (going) { const ms = mono() - t0; stat.calls++; stat.callMs += ms; if (drewNow) { stat.pictures++; stat.pictureMs += ms; } }
            return handed;
        }
        ctx.loop('GAME', 60, render);

        /* ---------- the tabs: the games, games from a phone, the settings ---------- */
        // On the game's screen, in the game's place (the top of this file says why). The page for a phone is
        // open while its tab shows and the car stands; BACK, which hides GAME, closes it.
        let addRec = null, pageKey = null;       // the tabs as they were last drawn, and what they were drawn from
        // (setting "Add games over the Wi-Fi the car is on", on at first: the page on a Wi-Fi the head unit has joined too)
        const joinedWifi = () => settings.get('joinedWifi') !== false;
        const phone = new Phone({ socket: process.env.SNES_LOADER_SOCK || config.loaderSocket, log, joined: joinedWifi, onChange: () => { pageKey = null; } });
        const tabs = new Tabs({
            games: () => lib.games, current: () => game || lib.last(), settings,
            onPlay: (g, fresh) => (fresh ? play(g, true) : pick(g)),
            onTab: (name) => show(name),
            // (the page of a phone's code is laid out 1600 x 520: as much smaller as the tabs leave it room)
            drawAdd: (r, x, y, k, h) => { const s = Math.min(1, h / H); addPage(r, driving(), phone.state, x + 40 * k * (1 - s), y, k * s); },
        });
        ui.onVisible((name, on) => {
            if (name !== 'GAME') return;
            pageKey = null;
            if (!on) { phone.close(); if (view === 'add') scan(); menu(); }
        });
        settings.onChange(() => { pageKey = null; });
        /** a QR code as dark runs on white paper, as big as fits a square of `side` at x, y */
        function code(cv, text, x, y, side) {
            const q = qr(text), k = Math.max(1, Math.floor(side / (q.size + 8))), at = Math.round((side - q.size * k) / 2);
            cv.fillRect(x, y, side, side, C.paper);
            for (let row = 0; row < q.size; row++) {
                for (let col = 0; col < q.size; col++) {
                    if (!q.modules[row * q.size + col]) continue;
                    let end = col;
                    while (end + 1 < q.size && q.modules[row * q.size + end + 1]) end++;
                    cv.fillRect(x + at + col * k, y + at + row * k, (end - col + 1) * k, k, C.ink);
                    col = end;
                }
            }
        }
        /**
         * The page: what to scan, or why there is nothing to. Laid out W x H, and drawn on r k times as big
         * with its top left corner at x0, y0.
         */
        function addPage(r, wait, s, x0, y0, k) {
            const page = s.page;
            const X = (x) => Math.round(x0 + x * k), Y = (y) => Math.round(y0 + y * k);
            const text = (t, x, y, size, colour, opts) => r.text(t, X(x), Y(y), size * k, colour, opts);
            const fits = (t, size, max) => fit(r, t, size * k, null, max * k);
            const lines = (list, x, y, size, colour, step) => list.forEach((t, i) => text(t, x, y + i * (step || size + 14), size, colour, { literal: true }));
            if (wait) {
                text('Parked only', 80, 150, 44, C.text, { font: 'bold' });
                lines(['The code to scan shows when the car stands.', 'Settings: Parked only.'], 80, 220, 30, C.dim);
            } else if (s.step === 'open' && page.url) {
                // which Wi-Fi the code is for: one the head unit has joined, or its own (the loader says: nets)
                const nets = page.nets || [], joined = !!nets[0] && nets[0].kind === 'joined';
                code(r, page.url, X(60), Y(40), Math.round(440 * k));
                text('Scan with your phone', 560, 86, 44, C.text, { font: 'bold' });
                lines([joined ? '1   The phone on the same Wi-Fi as the car (your home Wi-Fi, or the phone\'s own hotspot)'
                    : '1   The phone on the car\'s Wi-Fi (wireless CarPlay, or its hotspot)',
                    '2   Scan the code with the camera and pick your .sfc and .smc files',
                    '3   The games you send are in the tab "Games"'], 560, 146, 28, C.dim, 44);
                text(fits(page.url, 24, 900), 560, 290, 24, C.dim, { literal: true });
                const recent = (page.saved || []).slice(-4);
                recent.forEach((g, i) => {
                    const y = 346 + i * 40, bad = !!g.refused, side = Math.round(16 * k);
                    r.fillRect(X(560), Y(y - 20), side, side, bad ? C.bad : C.good);
                    text(fits(bad ? g.name + ': ' + g.refused : g.name + (g.removed ? ' removed' : g.replaced ? ' replaced' : ' added'), 28, 880), 592, y, 28, bad ? C.bad : C.good, { literal: true });
                });
                if (!recent.length && /^failed/.test(page.firewall || '')) lines(['The head unit\'s firewall could not be opened:', fits(page.firewall, 24, 900)], 560, 346, 24, C.bad);
                // the car's own Wi-Fi is up as well: a phone on wireless CarPlay is on that one, and this code is not for it
                else if (!recent.length && joined && nets.some((n) => n.kind === 'car')) {
                    lines(['A phone on wireless CarPlay is on the car\'s own Wi-Fi instead. For that, switch off', '"Add games over the Wi-Fi the car is on" in the tab "Settings".'], 560, 346, 24, C.dim);
                }
            } else if (s.step === 'open' && joinedWifi()) {
                text('No Wi-Fi to send over', 80, 150, 44, C.text, { font: 'bold' });
                lines(['Connect the car to the Wi-Fi your phone is on: your home Wi-Fi, or the phone\'s own hotspot.', 'Or connect the phone for wireless CarPlay. The code to scan shows here then.'], 80, 220, 30, C.dim);
            } else if (s.step === 'open') {
                text('The car\'s Wi-Fi is off', 80, 150, 44, C.text, { font: 'bold' });
                lines(['Switch on the car\'s hotspot, or connect the phone for wireless CarPlay.', 'The code to scan shows here then.'], 80, 220, 30, C.dim);
            } else if (s.step === 'missing') {
                text('This needs the SNES game loader', 80, 130, 44, C.text, { font: 'bold' });
                lines(['Install "SNES game loader" in the MGU Store, from the source this app came from,', 'and restart the head unit once.',
                    '', 'Without it: put your .sfc and .smc files in a folder "snes" on a USB stick.'], 80, 200, 30, C.dim);
            } else if (s.step === 'refused') {
                text('Restart the head unit once', 80, 150, 44, C.text, { font: 'bold' });
                lines(['The SNES game loader was installed before this app and does not know it yet.', 'Settings in the MGU Store: Restart head unit.'], 80, 220, 30, C.dim);
            } else if (s.step === 'failed') {
                text('The page did not open', 80, 150, 44, C.text, { font: 'bold' });
                lines([fits(String(s.error || ''), 30, 1400)], 80, 220, 30, C.bad);
            } else {
                text('Opening the page...', 80, 150, 44, C.text, { font: 'bold' });
            }
        }
        /** the touch buttons under the tabs (the HMI's own, hidden: as beside the game), and what else steers them */
        function strip(r, btns) {
            const top = HMI7.barTop + 10, bh = r.h - top - 10;
            let end = HMI7.btn.x;
            btns.forEach((b) => {
                const bx = b.x + 6, bw = b.w - 12;
                r.roundRect(bx, top, bw, bh, 16, ctl.lit(b.id) > 0 ? C.lit : C.btn);
                r.strokeRoundRect(bx, top, bw, bh, 16, 2, C.edge);
                r.text(String(BAR_TABS[b.id] || b.label).toUpperCase(), bx + bw / 2, top + bh / 2 + 15, 40, C.text, { align: 'center', font: 'bold' });
                end = b.x + b.w;
            });
            if (r.w - end < 560) return;
            r.text('Controller: turn or push to move, press to choose', end + 36, top + 38, 24, C.dim);
            r.text(pad.name ? 'Gamepad: D-pad and A; LB and RB for the tabs' : 'BACK: the menu. Games want a USB gamepad', end + 36, top + 78, 24, C.dim);
        }
        /** a frame of the game's screen while it shows the tabs (render) */
        function tabsFrame() {
            const now = Date.now();
            // a direction held on the gamepad moves on
            if (again && now >= again.at && (padWas & again.bit)) { tabs.input(again.ev); again.at = now + AGAIN_MS; }
            // the page for a phone is open while its tab is on screen and the car stands
            const wait = driving();
            if (view === 'add' && !wait) phone.open(); else phone.close();
            const cv = ctx.canvas(W, H), pl = cv.place, full = !!(pl && pl.full);
            const id7 = full && pl.w === HMI7.screen.w && pl.h === HMI7.screen.h;
            const btns = id7 && settings.get('touch') !== false ? ctx.display.buttons() : [];
            const notice = err || (wait ? 'Parked only: the games wait while the car moves' : null);
            const cur = game || lib.last();
            const key = [tabs.rev, view, notice, libRev, cur ? cur.id : '', btns.map((b) => (ctl.lit(b.id) > 0 ? 1 : 0)).join(''), pad.name,
                full, pl ? pl.w + 'x' + pl.h + '@' + pl.scale : 'no renderer'].join('|');
            const fresh = key !== pageKey;
            if (fresh) {
                // drawn anew only when what it shows changed (tabs.rev; phone.js and the settings say so too), or where it goes
                pageKey = key;
                const info = { notice, bad: !!err };
                if (full) {
                    // screen pixels, as the game's picture: the whole display but for the HMI's back arrow column
                    addRec = new Recorder(pl.w, pl.h);
                    const left = id7 ? HMI7.left : 0, colEnd = id7 ? HMI7.colEnd : 0;
                    addRec.fillRect(left, 0, pl.w - left, pl.h, C.bg);
                    if (left) addRec.fillRect(0, colEnd, left, pl.h - colEnd, C.bg);
                    // the page ends over the touch buttons, where there are any
                    const bottom = btns.length ? HMI7.barTop - 8 : pl.h - 20;
                    const k = Math.min((pl.w - left - 40) / W, (bottom - 20) / H);
                    tabs.draw(addRec, left + (pl.w - left - W * k) / 2, 20, k, (bottom - 20) / k, info);
                    if (btns.length) strip(addRec, btns);
                } else {
                    addRec = new Recorder(W, H, { textScale: pl ? pl.scale : 1 });
                    tabs.draw(addRec, 0, 0, 1, H, info);
                }
            }
            // without the renderer the HMI keeps the picture it has; the renderer wants a frame every second at least
            if (!pl && !fresh) return null;
            if (full) cv.clear([0, 0, 0, 0]).xf(1, 0, 0).append(addRec).xf(); else cv.clear(C.bg).append(addRec);
            return ui.image('GAME_GFX', cv);
        }
        log.info('snes app started: ' + ctx.spec.version + ', cores ' + Object.keys(CORES).map((k) => CORES[k]).join(' and '));
    },
});
