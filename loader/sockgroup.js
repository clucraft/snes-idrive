'use strict';
/**
 * sockgroup.js - who may talk to the loader: the SNES app, and nobody else.
 *
 * The control socket is root's alone when systemd makes it. Every app on the head unit runs as a user of its
 * own, whose group owns the app's folder; the socket gets that group of the SNES app (root:<group>, 0660), so
 * no other app can ask for the page. While the SNES app is not installed the socket stays root's (0600).
 *
 *   node sockgroup.js [socket]      the socket unit's ExecStartPost; the service does the same at each start
 *
 * Part of the SNES game loader (snes-idrive, MIT).
 */
const fs = require('fs');
const { findApp } = require('./games');

const SOCKET = '/run/clucraft-snes-loader.sock';

/** -> the group the socket now has, or null when it is root's alone */
function give(socket, oapDir) {
    const app = findApp(oapDir);
    if (!app || !app.gid) {
        fs.chownSync(socket, 0, 0);
        fs.chmodSync(socket, 0o600);
        return null;
    }
    fs.chownSync(socket, 0, app.gid);
    fs.chmodSync(socket, 0o660);
    return app.gid;
}

if (require.main === module) {
    // (always ends well: a failed ExecStartPost would fail the socket)
    try {
        const gid = give(process.argv[2] || SOCKET, process.env.SNES_LOADER_OAP);
        console.log('clucraft-snes-loader: the socket is ' + (gid === null ? 'root\'s alone (the SNES app is not installed)' : 'open to group ' + gid + ', the SNES app\'s'));
    } catch (e) { console.log('clucraft-snes-loader: socket: ' + e.message); }
    process.exit(0);
}

module.exports = { SOCKET, give };
