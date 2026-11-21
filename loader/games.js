'use strict';
/**
 * games.js - what the loader takes and where it puts it: SNES games, into the SNES app's own games folder.
 *
 * The folder is found here, by the app's name, never taken from a request: <oap>/oap_<uid>/data/roms, where
 * oap_<uid> is the folder whose source/package.json names the app. Each app on the head unit runs as its own
 * user, and <uid> is that user's number.
 *
 * As read on a car for the NES app, whose loader this one was made from (2026-11-20, the NES app as user 12244,
 * the MGU Store that installed it as 12201):
 *   drwxrwx---  8000:903     /var/opt/public/oap     (903 is a group the head unit gives its apps' processes)
 *   drwxr-x---  12201:12244  oap_12244
 *   drwxrwx---  12201:12244  oap_12244/data
 *   drwxrwx---  12244:12244  oap_12244/data/roms     (made by the app)
 * So the folder's owner is not the app's user, and the app's user alone, without that group, does not get as
 * far as its own folder: whoever saves games as that user is started inside `data` (service.js does that).
 *
 * What comes zipped is unpacked by the page first (page.js, unzip.js): what is saved is always the game itself.
 * A game is a file with an SNES cartridge's header in it (romInfo, which is the app's: app/snes-core.js has the
 * same function, and a test holds the two together), with a name made safe to create. Part of the SNES game
 * loader (snes-idrive, MIT). Runs on the head unit's Node 8.
 */
const fs = require('fs');
const path = require('path');

const APP = 'clucraft_snes';
const OAP_DIR = '/var/opt/public/oap';
const GAMES = 'roms';               // the games folder, in the app's data folder
const MAX_ROM = 8 * 1024 * 1024;    // the biggest game (the biggest cartridges made are 6 MB)
const MAX_GAME = MAX_ROM + 512;     // and a copier's header in front of it: the app reads no bigger file
const MAX_FOLDER = 96 << 20;        // all of them together: the app's share of the disk is 128 MB, and its saves are in it too
const MAX_GAMES = 1000;
const IS_GAME = /\.(sfc|smc)$/i;
const IS_ZIP = /\.zip$/i;            // a game as most collections keep it: the page unpacks it, and saves what is in it
const MAX_ZIP = MAX_GAME + (1 << 20); // the biggest .zip taken: a game that did not shrink, and what else is in it
const IN_ZIP = 20;                  // games taken out of one .zip, at most
const printable = (c) => (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xdf);   // ASCII, and the katakana of JIS X 0201

/**
 * What an .sfc / .smc file says about itself, or null when it is no SNES game: app/snes-core.js's romInfo, to
 * the letter (the loader is installed by itself and cannot ask the app). An SNES ROM has no signature at its
 * start; its header sits inside it, at one of three places, behind a copier's 512 bytes or not, and each place
 * is weighed the way Snes9x weighs them. The checksum counts for a header and is not insisted on.
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

/**
 * Where the app `name` lives: { root, data, games, uid, gid }, or null while it is not installed. uid is the
 * app's own user, the number in its folder's name; gid the folder's group, which is the app's.
 */
function findApp(oapDir, name) {
    const dir = oapDir || OAP_DIR;
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < entries.length; i++) {
        const root = path.join(dir, entries[i]);
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'source', 'package.json'), 'utf8'));
            if (!pkg || pkg.name !== (name || APP)) continue;
            const st = fs.statSync(root), data = path.join(root, 'data');
            return { root, data, games: path.join(data, GAMES), uid: Number(entries[i].slice(4)), gid: st.gid };
        } catch (e) { /* not an app's folder, or not ours to read */ }
    }
    return null;
}

/** the name a file sent as `raw` gets in the games folder, or null when it cannot be a game's */
function safeName(raw) {
    let name = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').pop();
    name = name.replace(/[^A-Za-z0-9 ._()[\]!&'+,-]/g, '_').replace(/\s+/g, ' ').trim();
    if (!IS_GAME.test(name)) return null;
    const ext = name.slice(-4).toLowerCase();                  // ".sfc" or ".smc"
    let base = name.slice(0, -4).replace(/^[ .]+/, '').replace(/[ .]+$/, '');
    if (!/[A-Za-z0-9]/.test(base)) return null;
    if (base.length > 76) base = base.slice(0, 76).replace(/[ .]+$/, '');
    return base + ext;
}

/** a name as it was sent, made fit to be shown and logged (the file is never created under it) */
function shown(raw) {
    return String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').pop().replace(/[^A-Za-z0-9 ._()[\]!&'+,-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** why `data` is no SNES game, or null when it is one */
function refuse(data) {
    if (!data || data.length < 0x8000) return 'too small to be an SNES game';
    if (data.length > MAX_GAME) return 'bigger than ' + (MAX_GAME >> 20) + ' MB';
    if (!romInfo(data)) return 'not an SNES game: no cartridge header in it';
    return null;
}

/** the games in the folder: [{ name, size }] by name. None while there is no folder; throws when it cannot be read. */
function list(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    names.filter((n) => IS_GAME.test(n) && n[0] !== '.').forEach((n) => {
        try { const st = fs.lstatSync(path.join(dir, n)); if (st.isFile()) out.push({ name: n, size: st.size }); } catch (e) { /* gone */ }
    });
    return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
}

/** why this process cannot keep games in the folder (an error's code), or null when it can */
function unusable(dir) {
    try {
        let there = true;
        try { fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; there = false; }
        fs.accessSync(there ? dir : path.dirname(dir), fs.constants.W_OK | fs.constants.X_OK);   // (no folder yet: save() makes it)
        return null;
    } catch (e) { return e.code || e.message; }
}

/** an error whose message is for the person at the phone */
function refused(message) { const e = new Error(message); e.refused = true; return e; }

/**
 * Puts a game into the folder: { name, size, replaced }. Throws (refused: true) when it is no game, or the
 * folder is full. The file is written beside its place first and then renamed, so the app never reads half of one.
 */
function save(dir, rawName, data) {
    const name = safeName(rawName);
    if (!name) throw refused('not a .sfc or .smc file');
    const why = refuse(data);
    if (why) throw refused(why);
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const have = list(dir), same = have.filter((g) => g.name.toLowerCase() === name.toLowerCase());
    const others = have.filter((g) => g.name.toLowerCase() !== name.toLowerCase());
    if (others.length >= MAX_GAMES) throw refused('there are ' + MAX_GAMES + ' games already');
    if (others.reduce((n, g) => n + g.size, 0) + data.length > MAX_FOLDER) throw refused('no room: the games folder holds ' + (MAX_FOLDER >> 20) + ' MB at most');
    const tmp = path.join(dir, '.' + name + '.' + process.pid + '.part');
    const fd = fs.openSync(tmp, 'wx', 0o644);          // (never through a link someone left there)
    try {
        fs.writeSync(fd, data, 0, data.length, 0);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.closeSync(fd); fs.unlinkSync(tmp); } catch (e2) { /* nothing to clear */ }
        throw e;
    }
    fs.closeSync(fd);
    // one file a name, whatever its letters' case (the app takes them as the same game)
    same.filter((g) => g.name !== name).forEach((g) => { try { fs.unlinkSync(path.join(dir, g.name)); } catch (e) { /* gone */ } });
    fs.renameSync(tmp, path.join(dir, name));
    return { name, size: data.length, replaced: same.length > 0 };
}

/** takes a game out of the folder; false when there is none of that name */
function remove(dir, rawName) {
    const name = safeName(rawName);
    if (!name) return false;
    const hit = list(dir).filter((g) => g.name.toLowerCase() === name.toLowerCase());
    hit.forEach((g) => fs.unlinkSync(path.join(dir, g.name)));
    return hit.length > 0;
}

/** files a save that was cut short left behind */
function sweep(dir) {
    try { fs.readdirSync(dir).filter((n) => /^\..*\.part$/.test(n)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } }); } catch (e) { /* no folder yet */ }
}

module.exports = { APP, OAP_DIR, GAMES, MAX_ROM, MAX_GAME, MAX_ZIP, IN_ZIP, MAX_FOLDER, MAX_GAMES, IS_GAME, IS_ZIP, findApp, safeName, shown, romInfo, refuse, list, unusable, save, remove, sweep };
