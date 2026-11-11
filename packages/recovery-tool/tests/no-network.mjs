// Loaded before the CLI: any attempt to use the network makes the process fail visibly.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const forbid = (name) => () => {
  process.stderr.write(`NETWORK-USED:${name}\n`);
  process.exit(99);
};

net.Socket.prototype.connect = forbid('net');
net.connect = forbid('net');
net.createConnection = forbid('net');
tls.connect = forbid('tls');
dns.lookup = forbid('dns');
dns.resolve = forbid('dns');
dgram.createSocket = forbid('dgram');
http.request = forbid('http');
http.get = forbid('http');
https.request = forbid('https');
https.get = forbid('https');
globalThis.fetch = forbid('fetch');
globalThis.WebSocket = forbid('websocket');
