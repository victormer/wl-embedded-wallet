import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRpc {
  url: string;
  calls: { method: string; params: unknown[] }[];
  state: { chainId: number; code: Record<string, string>; callResult: string | null; defaultCode: string };
  close(): Promise<void>;
}

/** A real JSON-RPC node over HTTP with the state each test asks for. */
export async function startFakeRpc(chainId: number, handlers: Record<string, (params: unknown[]) => unknown> = {}): Promise<FakeRpc> {
  const calls: FakeRpc['calls'] = [];
  const state: FakeRpc['state'] = { chainId, code: {}, callResult: null, defaultCode: '0x60' };
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      calls.push({ method, params });
      let result: unknown;
      if (handlers[method]) result = handlers[method](params);
      else if (method === 'eth_chainId') result = `0x${state.chainId.toString(16)}`;
      else if (method === 'eth_getCode') result = state.code[String(params[0]).toLowerCase()] ?? state.defaultCode;
      else if (method === 'eth_getBalance') result = '0x0';
      else if (method === 'eth_call') result = state.callResult;
      else if (method === 'eth_gasPrice') result = '0x10';
      else result = null;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
