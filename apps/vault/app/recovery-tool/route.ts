import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `pnpm build` generates it before `next build`, and `outputFileTracingIncludes` carries it into the `standalone` output.
const TOOL = join(process.cwd(), '../../packages/recovery-tool/dist/wl-embedded-wallet-recovery.html');

/** Public: it is open source and carries no user data. Always served as a download: it is used from `file://`, not from here. */
export async function GET(): Promise<Response> {
  let html: Buffer;
  try {
    html = await readFile(/*turbopackIgnore: true*/ TOOL);
  } catch {
    return new Response('Tool not available in this deployment.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response(new Uint8Array(html), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="wl-embedded-wallet-recovery.html"',
      'Cache-Control': 'no-store',
    },
  });
}
