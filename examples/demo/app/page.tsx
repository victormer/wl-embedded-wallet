import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { DOCS_URL, VERSION } from '@/lib/links';
import { pageSessionUser } from '@/server/page-session';
import { AuthForm } from './auth-form';
import { ChainBadge } from './_components/chain';
import { AppWindow, ArrowUpRight, FileKey, Fingerprint, Layers, Split } from './_components/icons';
import { SiteHeader } from './_components/site-shell';

export const dynamic = 'force-dynamic';

const SHARES = [
  { id: 'A', name: 'Vault server', unlock: 'Sealed with the server key' },
  { id: 'B', name: 'Your passkey', unlock: 'WebAuthn PRF' },
  { id: 'C', name: 'Recovery code', unlock: 'Argon2id' },
];

const FACTS = ['Seed rebuilt only in the browser', 'Shares verified by a signed manifest', 'Kit and code work offline'];

// The networks of the public deployment. The live demo lists the chains its server is configured with.
const NETWORKS = [
  { chainId: 11155111, name: 'Sepolia' },
  { chainId: 80002, name: 'Polygon Amoy' },
  { chainId: 84532, name: 'Base Sepolia' },
];

const CAPABILITIES: { icon: ReactNode; title: string; body: ReactNode }[] = [
  { icon: <Split />, title: '2-of-3 Shamir', body: 'Any two shares rebuild the BIP-39 seed. One alone reveals nothing.' },
  { icon: <Fingerprint />, title: 'Passkeys with PRF', body: 'Unlock with Face ID, Touch ID or a security key. No seed phrase to type.' },
  {
    icon: <Layers />,
    title: 'Safe smart accounts',
    body: (
      <>
        ERC-4337 Safe with the same address on every chain. Deployment can be sponsored.
        <span className="chain-badges">
          {NETWORKS.map((chain) => (
            <ChainBadge key={chain.chainId} chain={chain} />
          ))}
        </span>
      </>
    ),
  },
  { icon: <FileKey />, title: 'Offline recovery', body: 'An Emergency Kit and your recovery code open the wallet with no server, in a single-file tool with a published hash.' },
];

const STEPS: { title: string; body: string; vault: boolean }[] = [
  { title: 'Sign in to the app', body: 'Email, password and a TOTP code. This is the app’s own account: the vault never sees the password.', vault: false },
  { title: 'Activate the wallet', body: 'Create a passkey, write down the recovery code and download the Emergency Kit with its offline tool.', vault: true },
  { title: 'Deploy the Safe on a chain', body: 'Pick a network and deploy. The address does not change from one chain to another.', vault: true },
  { title: 'Sign', body: 'A message, EIP-712 typed data or a UserOperation. The app checks the signature against the Safe with ERC-1271.', vault: true },
  { title: 'Unlock, recover, relink or export', body: 'Test an unlock, recover without the passkey, link the wallet to another account or download the seed.', vault: true },
];

export default async function Page() {
  if (await pageSessionUser()) redirect('/wallet');
  return (
    <>
      <SiteHeader page="home" />
      <main className="home" id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">A non-custodial wallet your app can embed.</h1>
            <p className="lede">
              Your users get a Safe smart account with the same address on every EVM chain. Their seed is split 2-of-3 and only ever rebuilt in their browser, inside
              an isolated vault. Your app never sees a key.
            </p>
            <div className="hero-actions">
              <a className="btn btn-brand" href="#demo">
                Try the live demo
                <span className="brand-chip" aria-hidden="true">
                  <ArrowUpRight size={14} strokeWidth={2.25} />
                </span>
              </a>
              <a className="btn btn-outline" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                Read the docs
              </a>
            </div>
            <ul className="meta-chips" aria-label="Project status">
              <li className="chip">Open source</li>
              <li className="chip">Apache-2.0</li>
              <li className="chip mono-chip">v{VERSION}</li>
              <li className="chip caution">
                <span className="sq" aria-hidden="true" />
                Not audited
              </li>
            </ul>
          </div>

          <figure className="shares-card" aria-labelledby="shares-title">
            <figcaption id="shares-title" className="label">
              2-of-3 Shamir: any two rebuild the seed
            </figcaption>
            <ol className="shares">
              {SHARES.map((share) => (
                <li key={share.id} className="share">
                  <span className="share-id">{share.id}</span>
                  <span className="share-name">{share.name}</span>
                  <span className="share-unlock">{share.unlock}</span>
                </li>
              ))}
            </ol>
            <p className="shares-note">
              Everyday unlock uses <strong>A+B</strong>. Lost passkey: <strong>A+C</strong>. With no server at all, the Emergency Kit and your code still open the
              wallet.
            </p>
            <ul className="facts">
              {FACTS.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </figure>
        </section>

        <section className="capabilities" aria-label="Capabilities">
          {CAPABILITIES.map(({ icon, title, body }) => (
            <div key={title} className="capability">
              <span className="icon-tile" aria-hidden="true">
                {icon}
              </span>
              <h2>{title}</h2>
              <p>{body}</p>
            </div>
          ))}
        </section>

        <section className="how" id="how" aria-labelledby="how-title">
          <div className="section-head">
            <h2 id="how-title" className="section-title">
              How it works
            </h2>
            <p className="section-lede">
              Every step that touches a key happens in the vault window, on its own origin. The app only ever receives addresses and signatures.
            </p>
          </div>
          <ol className="rail">
            {STEPS.map((step, index) => (
              <li key={step.title} className={step.vault ? 'rail-step is-vault' : 'rail-step'}>
                <span className="rail-marker">{index + 1}</span>
                <div className="rail-body">
                  <p className="rail-title">
                    {step.title}
                    {step.vault ? (
                      <span className="tag vault-tag">
                        <AppWindow size={12} />
                        Vault window
                      </span>
                    ) : (
                      <span className="tag">App</span>
                    )}
                  </p>
                  <p className="rail-text">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="demo" id="demo" aria-labelledby="demo-title">
          <div className="section-head">
            <h2 id="demo-title" className="section-title">
              Live demo
            </h2>
            <p className="section-lede">Create a throwaway account. Everything runs on testnets.</p>
            <ul className="facts demo-needs">
              <li>A browser and passkey provider with PRF support</li>
              <li>An authenticator app for the TOTP code</li>
              <li>Pop-ups allowed for this site: the vault opens in its own window</li>
            </ul>
          </div>
          <AuthForm />
        </section>
      </main>
    </>
  );
}
