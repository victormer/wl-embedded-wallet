import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getTool } from '../../app/recovery-tool/route';
import { fetchRecoveryTool, RECOVERY_TOOL_PATH, RecoveryToolUnavailable } from '../../lib/recovery-tool';

const DIST = resolve('../../packages/recovery-tool/dist');

function respond(body: BodyInit | null, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

describe('fetchRecoveryTool: when it counts as downloaded', () => {
  beforeAll(() => {
    if (!existsSync(resolve(DIST, 'wl-embedded-wallet-recovery.html'))) {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: resolve('../../packages/recovery-tool'), stdio: 'pipe' });
    }
  });

  it('with what the vault route serves, and the fingerprint is that of the reproducible build', async () => {
    const requested: { url: string; cache?: RequestCache }[] = [];
    const tool = await fetchRecoveryTool(async (input, init) => {
      requested.push({ url: String(input), cache: init?.cache });
      return getTool();
    });
    expect(requested).toEqual([{ url: RECOVERY_TOOL_PATH, cache: 'no-store' }]);
    expect(tool.hash).toBe(createHash('sha256').update(tool.bytes).digest('hex'));
    expect(readFileSync(resolve(DIST, 'SHA256SUMS'), 'utf8')).toContain(`${tool.hash}  wl-embedded-wallet-recovery.html`);
  });

  it('a server error, a network error, an empty response or something that is not the tool do not count', async () => {
    const failing: (typeof fetch)[] = [
      respond('Tool not available in this deployment.', 404),
      respond('<!doctype html><title>Error</title>', 500),
      async () => {
        throw new TypeError('Failed to fetch');
      },
      respond(null),
      respond('{"error":"x"}'),
      respond('Tool not available'),
    ];
    for (const fetcher of failing) await expect(fetchRecoveryTool(fetcher)).rejects.toBeInstanceOf(RecoveryToolUnavailable);
  });

  it('accepts the HTML even if it starts with whitespace or is uppercase', async () => {
    const html = '\n  <!DOCTYPE html><html></html>';
    const tool = await fetchRecoveryTool(respond(html));
    expect(new TextDecoder().decode(tool.bytes)).toBe(html);
    expect(tool.hash).toBe(createHash('sha256').update(html).digest('hex'));
  });
});
