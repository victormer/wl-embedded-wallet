// Preload (`node --require ./peer-address.cjs server.js`) that hands route handlers the real socket address.
// Next only sets `x-forwarded-for` when the client did not send one, so the client can choose the address that
// rate limiting sees. Here every request gets `x-vault-peer-address` from the socket, and any copy the client sent
// is discarded. Only `node:http` is patched: TLS ends at the proxy in front, so the vault never runs an https server.
'use strict';

const http = require('node:http');

const HEADER = 'x-vault-peer-address';
const PATCHED = Symbol.for('wl-embedded-wallet.vault.peer-address');

if (!http.Server.prototype[PATCHED]) {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithPeerAddress(event, request, ...rest) {
    if (event === 'request' && request && request.headers) {
      const address = (request.socket && request.socket.remoteAddress) || '';
      // Node builds `headers` and `headersDistinct` lazily from `rawHeaders` using the header count it parsed, so both
      // are built first, from the untouched array, and then all three views are rewritten without the client's copy.
      const headers = request.headers;
      const distinct = request.headersDistinct;
      // Assigning replaces a client value, including several copies joined with ", ".
      headers[HEADER] = address;
      if (distinct && typeof distinct === 'object') distinct[HEADER] = [address];
      const raw = request.rawHeaders;
      if (Array.isArray(raw)) {
        for (let index = raw.length - 2; index >= 0; index -= 2) {
          if (String(raw[index]).toLowerCase() === HEADER) raw.splice(index, 2);
        }
        raw.push(HEADER, address);
      }
    }
    return emit.call(this, event, request, ...rest);
  };
  Object.defineProperty(http.Server.prototype, PATCHED, { value: true });
}

globalThis.__wdkVaultPeerAddress = true;
