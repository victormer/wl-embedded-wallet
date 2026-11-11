import { jwksHandler } from '@wl-embedded-wallet/sdk/server';
import { publishedJwks } from '@/server/handoff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public: only public keys. The vault verifies the tokens this backend issues with them. */
export const GET = jwksHandler(() => publishedJwks()?.keys ?? null);
