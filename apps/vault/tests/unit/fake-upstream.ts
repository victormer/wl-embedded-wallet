import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Thrown by a handler: the server answers with this JSON-RPC error. */
export class RpcFailure extends Error {
  constructor(
    message: string,
    readonly code = -32500,
  ) {
    super(message);
  }
}

export interface FakeUpstream {
  url: string;
  calls: { method: string; params: unknown[] }[];
  /** Calls of one method. */
  of(method: string): unknown[][];
  close(): Promise<void>;
}

/** A bundler or paymaster over HTTP. A missing handler answers `method not found`; handlers may be async. */
export async function startFakeUpstream(handlers: Record<string, (params: unknown[]) => unknown>): Promise<FakeUpstream> {
  const calls: FakeUpstream['calls'] = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', async () => {
      const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      calls.push({ method, params });
      let body: unknown;
      try {
        const handler = handlers[method];
        if (!handler) throw new RpcFailure(`method not found: ${method}`, -32601);
        body = { jsonrpc: '2.0', id, result: await handler(params) };
      } catch (error) {
        body = { jsonrpc: '2.0', id, error: { code: (error as RpcFailure).code ?? -32000, message: (error as Error).message } };
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    of: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
