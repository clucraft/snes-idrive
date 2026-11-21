'use strict';
/**
 * pad.js - the app's side of a USB gamepad.
 *
 * The app cannot read one itself: the head unit's kernel has no gamepad driver, and its USB devices are not
 * an app's to open. The SNES game loader (loader/ in the repository; "SNES game loader" in the MGU Store) reads
 * the pad and tells its buttons over the socket the app also asks for "Add games from a phone" on
 * (loader/service.js, loader/pad.js). This is the asking, and the pad's buttons as the SNES pad's.
 *
 *   const pad = new Pad({ socket, log, onMask, letters: () => false });
 *   pad.start();         the game's screen is up: ask for a pad's buttons, and keep asking while it is
 *   pad.stop();          it is gone: the loader lets go of the pad
 *   onMask(mask)         the SNES pad's buttons the gamepad holds now (BTN masks; 0 when it lets go or is gone)
 *   onButtons(buttons)   the gamepad's own buttons (PAD masks): for the tabs (tabs.js), and for the way out of a
 *                        game, which no SNES button can be
 *   pad.name             the pad's name while one is plugged in, else null
 *
 * Xbox pad -> SNES pad, by where a button is and not by its letter: the SNES pad has A on the right and B at the
 * bottom, the Xbox pad the other way round, and a game's "jump" and "run" are where the thumb expects them only
 * when the positions match.
 *
 *     Xbox pad          SNES pad                         with opts.letters() true
 *     A (bottom)        B                                A
 *     B (right)         A                                B
 *     X (left)          Y                                X
 *     Y (top)           X                                Y
 *     LB, RB            L, R
 *     Menu, View        Start, Select
 *     D-pad, left stick the D-pad
 *
 * Both sticks pressed in together, or the Xbox button, are nothing to a game: they are the way out of one (main.js).
 */
const net = require('net');
const { BTN } = require('./snes-core');

const SOCKET = '/run/clucraft-snes-loader.sock';
const RETRY_MS = 5000;
/** a pad's buttons as the loader tells them (loader/pad.js has the same) */
const PAD = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, A: 0x10, B: 0x20, X: 0x40, Y: 0x80, START: 0x100, SELECT: 0x200, L: 0x400, R: 0x800,
    LS: 0x1000, RS: 0x2000, GUIDE: 0x4000 };           // the sticks pressed in, the Xbox button

const SAME = [[PAD.UP, BTN.UP], [PAD.DOWN, BTN.DOWN], [PAD.LEFT, BTN.LEFT], [PAD.RIGHT, BTN.RIGHT], [PAD.START, BTN.START],
    [PAD.SELECT, BTN.SELECT], [PAD.L, BTN.L], [PAD.R, BTN.R]];
const BY_PLACE = [[PAD.A, BTN.B], [PAD.B, BTN.A], [PAD.X, BTN.Y], [PAD.Y, BTN.X]];
const BY_LETTER = [[PAD.A, BTN.A], [PAD.B, BTN.B], [PAD.X, BTN.X], [PAD.Y, BTN.Y]];

/** the gamepad's buttons -> the SNES pad's (letters: by a button's letter, not by where it is) */
function toSnes(b, letters) {
    let m = 0;
    SAME.forEach((p) => { if (b & p[0]) m |= p[1]; });
    (letters ? BY_LETTER : BY_PLACE).forEach((p) => { if (b & p[0]) m |= p[1]; });
    return m;
}
/** the way out of a game: both sticks pressed in, or the Xbox button */
const wantsOut = (b) => (b & PAD.LS && b & PAD.RS) || !!(b & PAD.GUIDE);

class Pad {
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || console;
        this.socket = this.o.socket || SOCKET;
        this.wanted = false;
        this.conn = null;
        this.retry = null;
        this.mask = 0;
        this.buttons = 0;
        this.name = null;
        this.given = false;             // the loader has no gamepads (an older one), or cannot read this one: not asked again
        this.said = '';
    }

    _say(s) { if (s !== this.said) { this.said = s; this.log.info('gamepad: ' + s); } }

    /** b: the gamepad's buttons as the loader tells them (0: let go, or no pad) */
    _mask(b) {
        const m = toSnes(b, !!(this.o.letters && this.o.letters())), was = this.buttons;
        this.buttons = b;
        // (the SNES pad's first: a button that chooses a game on the tabs is known as held when the game starts)
        if (m !== this.mask) {
            this.mask = m;
            if (this.o.onMask) { try { this.o.onMask(m); } catch (e) { this.log.error('gamepad: onMask', e); } }
        }
        if (b !== was && this.o.onButtons) { try { this.o.onButtons(b); } catch (e) { this.log.error('gamepad: onButtons', e); } }
    }

    start() {
        if (this.wanted) return;
        this.wanted = true;
        this.given = false;
        this._connect();
    }

    stop() {
        if (!this.wanted) return;
        this.wanted = false;
        clearTimeout(this.retry);
        const c = this.conn;
        this.conn = null;
        if (c) c.destroy();
        this.name = null;
        this._mask(0);
    }

    _again() {
        clearTimeout(this.retry);
        if (this.wanted && !this.given) this.retry = setTimeout(() => this._connect(), RETRY_MS);
    }

    _connect() {
        if (!this.wanted || this.conn || this.given) return;
        let c;
        try { c = net.connect(this.socket); } catch (e) { return this._again(); }
        this.conn = c;
        let text = '';
        c.setEncoding('utf8');
        c.on('connect', () => c.write('{"cmd":"pad"}\n'));
        c.on('data', (d) => {
            if (this.conn !== c) return;
            text += d;
            if (text.length > 65536) { c.destroy(); return; }
            for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
                const line = text.slice(0, nl);
                text = text.slice(nl + 1);
                let m = null;
                try { m = JSON.parse(line); } catch (e) { continue; }
                if (!m) continue;
                const p = m.pad;
                // a loader from before it read gamepads says "unknown"; one that cannot read this pad says why
                if (m.ok === false || (p && p.error)) {
                    const why = String((p && p.error) || m.error || 'the SNES game loader refused');
                    this._say(/^unknown/.test(why) ? 'this SNES game loader reads no gamepads yet: update it in the MGU Store' : why);
                    this.given = true;
                    this.name = null;
                    this._mask(0);
                    c.destroy();
                    return;
                }
                if (!p || !p.on) continue;
                this.name = typeof p.name === 'string' ? p.name : null;
                this._say(this.name ? this.name + ' plugged in' : 'none plugged in');
                this._mask(this.name ? p.buttons | 0 : 0);
            }
        });
        const gone = () => {
            if (this.conn !== c) return;
            this.conn = null;
            this.name = null;
            this._mask(0);
            this._again();
        };
        // (no socket: the loader is not installed, and a pad needs it; it is asked again in case it is on its way)
        c.on('error', gone);
        c.on('close', gone);
    }
}

module.exports = { Pad, PAD, toSnes, wantsOut, SOCKET };
