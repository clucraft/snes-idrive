'use strict';
/**
 * unzip.js - the games out of a .zip file. Most collections of games keep each one zipped.
 *
 *   isZip(bytes)                         it starts as a zip file does
 *   entries(bytes)                       the files in it: [{ name, method, packed, size, crc, at, encrypted }];
 *                                        throws when it is no zip this reads
 *   extract(bytes, entry, max)           a Promise of one file's bytes, at most `max` of them
 *   games(bytes, { isGame, max, most })  a Promise of [{ name, data }]: the files whose names say they are
 *                                        games (isGame, a RegExp), in the zip's order, `most` of them at most
 *
 * An error that is the zip's fault has `zip: true` and a message for whoever supplied the file.
 *
 * Read here: files stored as they are and deflated ones, which is what zip programs write. Not read: a zip in
 * several parts, one with a password, one over 4 GB (zip64), other ways of packing.
 *
 * A zip says how big each file in it is, and that need not be true: a few kilobytes can unpack to gigabytes.
 * So a file that says it is bigger than `max` is not unpacked at all, and one that is unpacked is given up on
 * as soon as more comes out than it said: what is held never exceeds what it said, and the work stops with the
 * slice of packed bytes in hand (8 KB). Then its length and its checksum have to be what the zip says.
 * Nothing here trusts a number in the file further than the file's end.
 *
 * The same file is in app/ and in loader/ (the loader is installed by itself and cannot ask the app); a test
 * holds the two together. MIT. Runs on the head unit's Node 8.
 */
const zlib = require('zlib');

const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_ENTRIES = 4096;           // files in one zip, at most
const SLICE = 8192;                 // packed bytes handed to the unpacker at a time

function bad(message) { const e = new Error(message); e.zip = true; return e; }

let table = null;
/** the CRC-32 a zip keeps of each file */
function crc32(b) {
    if (!table) { table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
    let c = -1;
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function isZip(b) { return !!b && b.length >= 22 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6)); }

function entries(b) {
    if (!isZip(b)) throw bad('not a zip file');
    // the record at its end, behind which a comment of up to 64 KB may stand
    let end = -1;
    for (let i = b.length - 22, stop = Math.max(0, b.length - 22 - 65535); i >= stop; i--) if (b.readUInt32LE(i) === END) { end = i; break; }
    if (end < 0) throw bad('a damaged zip (it has no end)');
    const count = b.readUInt16LE(end + 10), size = b.readUInt32LE(end + 12), at = b.readUInt32LE(end + 16);
    if (b.readUInt16LE(end + 4) !== 0 || b.readUInt16LE(end + 6) !== 0 || b.readUInt16LE(end + 8) !== count) throw bad('a zip in several parts');
    if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) throw bad('a zip too big to read here');
    if (count > MAX_ENTRIES) throw bad('a zip of more than ' + MAX_ENTRIES + ' files');
    if (at + size > end) throw bad('a damaged zip');
    const out = [];
    let p = at;
    for (let i = 0; i < count; i++) {
        if (p + 46 > at + size || b.readUInt32LE(p) !== CENTRAL) throw bad('a damaged zip');
        const flags = b.readUInt16LE(p + 8), n = b.readUInt16LE(p + 28), m = b.readUInt16LE(p + 30), k = b.readUInt16LE(p + 32);
        if (p + 46 + n + m + k > at + size) throw bad('a damaged zip');
        out.push({
            name: b.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + n), method: b.readUInt16LE(p + 10),
            packed: b.readUInt32LE(p + 20), size: b.readUInt32LE(p + 24), crc: b.readUInt32LE(p + 16), at: b.readUInt32LE(p + 42), encrypted: !!(flags & 1),
        });
        p += 46 + n + m + k;
    }
    return out;
}

function extract(b, entry, max) {
    return new Promise((resolve, reject) => {
        const e = entry;
        if (e.encrypted) throw bad('a zip with a password');
        if (e.method !== 0 && e.method !== 8) throw bad('a zip packed in a way that is not read here');
        if (e.size === 0xffffffff || e.packed === 0xffffffff) throw bad('a zip too big to read here');
        if (e.size > max) throw bad('bigger than ' + Math.floor(max / 1048576) + ' MB');
        // where the file's bytes are: behind its own header, which repeats its name
        if (e.at + 30 > b.length || b.readUInt32LE(e.at) !== LOCAL) throw bad('a damaged zip');
        const from = e.at + 30 + b.readUInt16LE(e.at + 26) + b.readUInt16LE(e.at + 28);
        if (from + e.packed > b.length) throw bad('a damaged zip');
        const data = b.slice(from, from + e.packed);
        const check = (out) => { if (out.length !== e.size || crc32(out) !== e.crc) throw bad('a damaged zip'); return out; };
        if (e.method === 0) { if (e.packed !== e.size) throw bad('a damaged zip'); resolve(check(Buffer.from(data))); return; }
        // Unpacked a slice of the packed bytes at a time, and looked at between slices: once more has come out
        // than the zip said, no further slice goes in. (The unpacker is never closed while it works on a slice:
        // Node 8's throws from inside itself then, which nothing could catch.) What came out too much is dropped
        // as it comes, so no more is ever held than the file was said to be.
        const inflate = zlib.createInflateRaw(), parts = [];
        let n = 0, at = 0, error = null, settled = false;
        const settle = (err, out) => {
            if (settled) return;
            settled = true;
            parts.length = 0;
            if (err) reject(err); else resolve(out);
        };
        inflate.on('data', (d) => {
            if (error) return;
            n += d.length;
            if (n > e.size) { error = bad('a damaged zip (more in it than it says)'); parts.length = 0; return; }
            parts.push(d);
        });
        inflate.on('error', () => settle(error || bad('a damaged zip')));          // (it closes itself on an error)
        inflate.on('end', () => {
            if (error) return settle(error);
            try { settle(null, check(Buffer.concat(parts, n))); } catch (err) { settle(err); }
        });
        const feed = () => {
            if (settled) return;
            if (error) {
                // nothing is being unpacked now: the unpacker can go
                setImmediate(() => { try { inflate.close(); } catch (x) { /* closed */ } });
                return settle(error);
            }
            if (at >= data.length) { inflate.end(); return; }
            const slice = data.slice(at, at + SLICE);
            at += slice.length;
            inflate.write(slice, feed);
        };
        feed();
    });
}

function games(b, opts) {
    const o = opts || {}, most = o.most || 1;
    let list;
    try { list = entries(b); } catch (e) { return Promise.reject(e); }
    // (no folders, and none of the hidden files some computers put beside every file)
    const named = list.filter((e) => o.isGame.test(e.name) && !/\/$/.test(e.name) && !/(^|\/)\.[^/]*$/.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name));
    if (!named.length) return Promise.reject(bad('no game in the zip'));
    const out = [];
    let why = null;
    const next = (i) => {
        if (i >= named.length || out.length >= most) {
            if (out.length) return out;
            throw why || bad('no game in the zip');
        }
        return extract(b, named[i], o.max).then((data) => { out.push({ name: named[i].name, data }); }, (e) => { if (!e.zip) throw e; why = why || e; }).then(() => next(i + 1));
    };
    return Promise.resolve().then(() => next(0));
}

module.exports = { isZip, entries, extract, games, crc32 };
