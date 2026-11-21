'use strict';
// Takes the page's rules out of the firewall, if any are left: the service's ExecStopPost (so also after a crash
// or a kill) and the tool's "deactivate", before a removal. Always ends well: a failing one would refuse the removal.
try {
    const n = require('./nft').shut({ program: process.env.SNES_LOADER_NFT });
    if (n) console.log('clucraft-snes-loader: took ' + n + ' rule(s) out of the firewall');
} catch (e) {
    console.log('clucraft-snes-loader: cleanup: ' + (e && e.message));
}
process.exit(0);
