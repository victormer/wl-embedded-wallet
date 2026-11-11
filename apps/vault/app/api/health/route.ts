import { json } from '@/server/http';
import { ping } from '@/server/store';

export const runtime = 'nodejs';

/** For the orchestrator. Reveals neither version nor configuration. */
export async function GET() {
  try {
    await ping();
    return json({ status: 'ok' });
  } catch {
    return json({ status: 'unavailable' }, 503);
  }
}
