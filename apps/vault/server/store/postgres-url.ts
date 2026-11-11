/**
 * Neon (and the Vercel Marketplace integration) hands out URLs with `sslmode=require&channel_binding=require`.
 * pg-connection-string already treats `require`, `prefer` and `verify-ca` as `verify-full` and prints a SECURITY
 * WARNING for them; spelling it `verify-full` keeps that behaviour and silences the warning. `channel_binding` is not
 * a connection-string parameter for `pg`: `require` becomes the Pool option `enableChannelBinding`, and `disable` or
 * `prefer` are dropped. Every other part of the URL is kept verbatim.
 *
 * Pure, and the URL carries the password: neither it nor the parse error is ever logged or included in a message.
 */
export interface NormalizedPostgresUrl {
  connectionString: string;
  enableChannelBinding: boolean;
}

const VERIFY_FULL_ALIASES = new Set(['require', 'prefer', 'verify-ca']);
const DROPPED_CHANNEL_BINDING = new Set(['disable', 'prefer']);

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

export function normalizePostgresUrl(url: string): NormalizedPostgresUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not the parse error itself: it carries the input.
    throw new Error('DATABASE_URL is not a valid URL');
  }
  let changed = false;
  let enableChannelBinding = false;
  const kept: string[] = [];
  // On the raw pairs, so that the parameters left alone keep their exact encoding.
  for (const pair of parsed.search.slice(1).split('&')) {
    if (pair === '') continue;
    const separator = pair.indexOf('=');
    const key = decode(separator === -1 ? pair : pair.slice(0, separator));
    const value = separator === -1 ? '' : decode(pair.slice(separator + 1));
    if (key === 'sslmode' && VERIFY_FULL_ALIASES.has(value)) {
      kept.push('sslmode=verify-full');
      changed = true;
    } else if (key === 'channel_binding' && value === 'require') {
      enableChannelBinding = true;
      changed = true;
    } else if (key === 'channel_binding' && DROPPED_CHANNEL_BINDING.has(value)) {
      changed = true;
    } else {
      kept.push(pair);
    }
  }
  if (!changed) return { connectionString: url, enableChannelBinding };
  parsed.search = kept.length ? `?${kept.join('&')}` : '';
  return { connectionString: parsed.href, enableChannelBinding };
}
