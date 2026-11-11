'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { QrCode } from './_components/qr-code';
import { Notice } from './_components/notice';
import { CopyButton } from './_components/copy-value';

type Mode = 'login' | 'register';
type TotpSetup = { secret: string; otpauthUri: string };
// After the password: set up 2FA (registration, or an account created before it) or ask for its code.
type Stage = { name: 'credentials' } | { name: 'totp'; setup: TotpSetup | null };

const ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  EMAIL_TAKEN: 'An account with that email already exists.',
  INVALID_INPUT: 'Enter a valid email and a password of at least 8 characters.',
  INVALID_TOTP: 'The verification code is incorrect.',
  UNAUTHORIZED: 'Your session has expired. Enter your password again.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
};

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>({ name: 'credentials' });
  const [code, setCode] = useState('');

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function postJson(path: string, body?: unknown): Promise<Response> {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function showError(response: Response) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setError(ERRORS[body?.error ?? ''] ?? 'The operation could not be completed.');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await postJson(`/api/auth/${mode}`, { email, password });
      if (!response.ok) {
        await showError(response);
      } else if (((await response.json()) as { next: string }).next === 'totp') {
        setStage({ name: 'totp', setup: null });
      } else {
        const setup = await postJson('/api/auth/totp/setup');
        if (setup.ok) setStage({ name: 'totp', setup: (await setup.json()) as TotpSetup });
        else await showError(setup);
      }
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await postJson('/api/auth/totp', { totp: code.trim() });
      if (response.ok) {
        router.replace('/wallet');
        return;
      }
      await showError(response);
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  }

  if (stage.name === 'totp') {
    const { setup } = stage;
    return (
      <form className="panel auth" onSubmit={submitCode} data-testid="totp-step">
        <div className="panel-head">
          <h3 className="panel-title">{setup ? 'Secure your account' : 'Verify it’s you'}</h3>
          <span className="chip">Step 2 of 2</span>
        </div>
        <div className="panel-body">
          <p className="muted">{setup ? 'Scan this code with your authenticator app (Google Authenticator, 1Password…).' : 'Enter the code from your authenticator app.'}</p>
          {setup && (
            <>
              <div className="qr-tile">
                <QrCode text={setup.otpauthUri} label="QR code for your authenticator app" testId="totp-qr" />
              </div>
              <div className="field">
                <span className="label">Can’t scan it? Enter this key</span>
                <div className="copy-value">
                  <span className="mono copy-value-text" data-testid="totp-secret">
                    {setup.secret}
                  </span>
                  <span className="copy-value-tools">
                    <CopyButton value={setup.secret} label="Copy the key" />
                  </span>
                </div>
              </div>
            </>
          )}
          <label className="field">
            <span className="label">6-digit code</span>
            <input
              className="input input-code"
              data-testid="totp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {error && (
            <Notice kind="error" role="alert" data-testid="auth-error">
              {error}
            </Notice>
          )}
          <button className="btn btn-block" type="submit" data-testid="totp-submit" disabled={busy || code.trim().length !== 6}>
            Verify
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="panel auth" onSubmit={submit}>
      <div className="tabs-line" role="tablist" aria-label="Account">
        <button type="button" role="tab" aria-selected={mode === 'login'} data-testid="auth-tab-login" onClick={() => switchMode('login')}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'register'} data-testid="auth-tab-register" onClick={() => switchMode('register')}>
          Create account
        </button>
      </div>
      <div className="panel-body">
        <p className="muted">{mode === 'login' ? 'Sign in to view or activate your wallet.' : 'A demo account in this app. Use any email: nothing is sent to it.'}</p>
        <label className="field">
          <span className="label">Email</span>
          <input className="input" data-testid="auth-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            data-testid="auth-password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mode === 'register' && <span className="hint">At least 8 characters.</span>}
        </label>
        {error && (
          <Notice kind="error" role="alert" data-testid="auth-error">
            {error}
          </Notice>
        )}
        <button className="btn btn-block" type="submit" data-testid="auth-submit" disabled={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </div>
    </form>
  );
}
