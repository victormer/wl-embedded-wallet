import { cookies } from 'next/headers';
import { getUserBySession, type UserRecord } from './db';
import { SESSION_COOKIE } from './http';

export async function pageSessionUser(): Promise<UserRecord | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? await getUserBySession(token) : null;
}
