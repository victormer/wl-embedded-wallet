import './trusted-types';
import { createRoot } from 'react-dom/client';
import { RecoverWithKit, type RecoveryChannel } from '@/app/_components/recover-offline';
import { setSignerWorkerFactory } from '@/lib/signer-client';

// No app and no backend. The same components and the same worker logic as `/recover`.
const channel: RecoveryChannel = { state: 'no-opener', respond: () => undefined };

setSignerWorkerFactory(() => new Worker(new URL('./recovery-worker.js', document.baseURI), { type: 'module' }));

createRoot(document.getElementById('root') as HTMLElement).render(<RecoverWithKit channel={channel} offersTool={false} />);
