const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

export function parseCredentials(body: Record<string, unknown> | null): { email: string; password: string } | null {
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') return null;
  const email = body.email.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  if (body.password.length < MIN_PASSWORD_LENGTH || body.password.length > MAX_PASSWORD_LENGTH) return null;
  return { email, password: body.password };
}
