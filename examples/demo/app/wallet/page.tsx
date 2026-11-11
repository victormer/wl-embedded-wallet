import { redirect } from 'next/navigation';
import { publicDemoChains } from '@/server/chains';
import { pageSessionUser } from '@/server/page-session';
import { WalletPanel } from './wallet-panel';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await pageSessionUser();
  if (!user) redirect('/');
  // Read on every request, so it is not baked into the build.
  const vaultOrigin = process.env.VAULT_ORIGIN;
  if (!vaultOrigin) throw new Error('VAULT_ORIGIN is missing');
  return (
    <main>
      <WalletPanel email={user.email} vaultOrigin={vaultOrigin} chains={publicDemoChains()} />
    </main>
  );
}
