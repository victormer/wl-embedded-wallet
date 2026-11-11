import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/config', () => ({ validateConfig: () => [] }));
vi.mock('../../server/brand', () => ({ loadBrandFromEnv: () => ({ issues: [] }) }));
vi.mock('../../server/store', () => ({ getStore: async () => ({}) }));

const PRELOAD = fileURLToPath(new URL('../../scripts/peer-address.cjs', import.meta.url));
const HEADER = 'x-vault-peer-address';
const FORGED = '6.6.6.6';

// Answers with what a route handler would see: the parsed header, any client copy left in `rawHeaders`, and the flag.
const SERVER = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  const raw = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === '${HEADER}') raw.push(req.rawHeaders[i + 1]);
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    header: req.headers['${HEADER}'] ?? null,
    distinct: req.headersDistinct['${HEADER}'] ?? null,
    raw,
    socket: req.socket.remoteAddress,
    flag: globalThis.__wdkVaultPeerAddress === true,
  }));
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

interface Seen {
  header: string | null;
  distinct: string[] | null;
  raw: string[];
  socket: string;
  flag: boolean;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  delete (globalThis as { __wdkVaultPeerAddress?: boolean }).__wdkVaultPeerAddress;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function startServer(preload: boolean): Promise<number> {
  const args = preload ? ['--require', PRELOAD, '-e', SERVER] : ['-e', SERVER];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    child.once('exit', (code) => reject(new Error(`The test server exited (${code})`)));
  });
}

// `node:http` with raw headers so the client sends exactly these, repeated ones included (and then `host` by hand).
function send(port: number, headers: [string, string][]): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const raw = [['host', `127.0.0.1:${port}`], ...headers].flat();
    const req = request({ host: '127.0.0.1', port, path: '/', headers: raw }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body) as Seen) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.end();
  });
}

const LOOPBACK = ['127.0.0.1', '::ffff:127.0.0.1'];

describe('peer-address preload', () => {
  it('replaces a forged header with the socket address in every view of the headers', async () => {
    const port = await startServer(true);
    const seen = await send(port, [[HEADER, FORGED]]);
    expect(LOOPBACK).toContain(seen.header);
    expect(seen.header).toBe(seen.socket);
    expect(seen.distinct).toEqual([seen.socket]);
    expect(seen.raw).toEqual([seen.socket]);
    expect(JSON.stringify(seen)).not.toContain(FORGED);
    expect(seen.flag).toBe(true);
  });

  it('drops every copy when the client repeats the header, whatever its case', async () => {
    const port = await startServer(true);
    const seen = await send(port, [
      [HEADER, FORGED],
      ['X-Vault-Peer-Address', '7.7.7.7'],
    ]);
    expect(LOOPBACK).toContain(seen.header);
    expect(seen.raw).toEqual([seen.socket]);
    expect(JSON.stringify(seen)).not.toMatch(/6\.6\.6\.6|7\.7\.7\.7/);
  });

  it('sets the header even when the client sends none', async () => {
    const port = await startServer(true);
    const seen = await send(port, []);
    expect(LOOPBACK).toContain(seen.header);
    expect(seen.flag).toBe(true);
  });

  it('patches only once when loaded again', () => {
    const script = `
      const http = require('node:http');
      const first = http.Server.prototype.emit;
      delete require.cache[${JSON.stringify(PRELOAD)}];
      require(${JSON.stringify(PRELOAD)});
      process.stdout.write(String(http.Server.prototype.emit === first));
    `;
    const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], { encoding: 'utf8' });
    expect(result.stdout).toBe('true');
  });

  it('without the preload, the client value passes through and the flag is unset', async () => {
    const port = await startServer(false);
    const seen = await send(port, [[HEADER, FORGED]]);
    expect(seen.header).toBe(FORGED);
    expect(seen.flag).toBe(false);
  });
});

describe('startup peer-address check', () => {
  async function runStartup() {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { startup } = await import('../../server/startup');
    await startup();
    return { exit, errors: error.mock.calls.map((call) => String(call[0])) };
  }

  it('refuses to start in production without the preload, naming it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { exit, errors } = await runStartup();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual([expect.stringMatching(/^Invalid configuration: peer-address preload .*--require \.\/peer-address\.cjs/)]);
  });

  it('starts in production with the preload', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    (globalThis as { __wdkVaultPeerAddress?: boolean }).__wdkVaultPeerAddress = true;
    const { exit, errors } = await runStartup();
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('on Vercel with CLIENT_IP_SOURCE=vercel it starts without the preload', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CLIENT_IP_SOURCE', 'vercel');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_REGION', 'fra1');
    const { exit, errors } = await runStartup();
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('CLIENT_IP_SOURCE=vercel outside Vercel still needs the preload (validateConfig reports the source too)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CLIENT_IP_SOURCE', 'vercel');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_REGION', '');
    const { exit, errors } = await runStartup();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual([expect.stringMatching(/^Invalid configuration: peer-address preload/)]);
  });

  it('does not fail outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { exit, errors } = await runStartup();
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});
