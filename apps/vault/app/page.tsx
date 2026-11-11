import Link from 'next/link';
import { Screen } from './_components/ui';

export default function HomePage() {
  return (
    <Screen title="Key vault" testId="home">
      <p>This vault is used from an authorized app, which opens each request here.</p>
      <p>
        If you have your emergency kit, you can <Link className="link" href="/recover" prefetch={false}>recover your wallet with it</Link>.
      </p>
    </Screen>
  );
}
