'use client';

import { VAULT_PROTOCOL, type UserOperationJson, type VaultReady, type VaultRequest, type VaultResult } from '@wl-embedded-wallet/sdk/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

export type VaultRoute = VaultRequest['action']['kind'];
export type VaultOutcome =
  | {
      ok: true;
      address: `0x${string}`;
      owner: `0x${string}`;
      signature?: `0x${string}`;
      userOperation?: UserOperationJson;
      userOpHash?: `0x${string}`;
      transactionHash?: `0x${string}`;
    }
  | { ok: false; code: string };

export type ChannelState = 'connecting' | 'no-opener' | 'invalid' | 'ready';

export interface VaultChannel {
  state: ChannelState;
  /** App origin verified by the server with the token. `null` until then. */
  origin: string | null;
  request: VaultRequest | null;
  /** What the server returns when redeeming the token: it must be the request's `event.origin`. */
  confirmOrigin(origin: string): boolean;
  /** Request origin as reported by the browser, used to redeem the token. Not yet verified. */
  requestOrigin: string | null;
  respond(outcome: VaultOutcome): void;
  /** Asks for another request with a new token: tokens are single-use and last 60 s, and switching tabs may require one. */
  renew(): void;
}

function isVaultRequest(data: unknown): data is VaultRequest {
  const value = data as Partial<VaultRequest> | null;
  return (
    typeof value === 'object' &&
    value !== null &&
    value.protocol === VAULT_PROTOCOL &&
    value.type === 'request' &&
    typeof value.id === 'string' &&
    typeof value.token === 'string' &&
    typeof value.action === 'object' &&
    value.action !== null
  );
}

/**
 * The vault does not know the app's origin in advance: it is authorized by the token signed by the app's backend.
 * That is why `ready`, and only `ready`, which carries no data, is sent with `*`. Only `window.opener`
 * is listened to. A result with data is only sent after the origin is verified, and only to that exact origin.
 */
export function useVaultChannel(route: VaultRoute): VaultChannel {
  const [state, setState] = useState<ChannelState>('connecting');
  const [origin, setOrigin] = useState<string | null>(null);
  const [requestOrigin, setRequestOrigin] = useState<string | null>(null);
  const [request, setRequest] = useState<VaultRequest | null>(null);
  const announced = useRef(false);
  const accepted = useRef<{ id: string; origin: string } | null>(null);
  const verified = useRef(false);
  const responded = useRef(false);

  const post = useCallback((id: string, target: string, outcome: VaultOutcome) => {
    const result: VaultResult = { protocol: VAULT_PROTOCOL, type: 'result', id, ...outcome };
    (window.opener as Window | null)?.postMessage(result, target);
  }, []);

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      setState('no-opener');
      return;
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      // An opaque origin can be neither verified nor used as a target.
      if (event.source !== opener || event.origin === 'null') return;
      if (accepted.current || !isVaultRequest(event.data)) return;
      const message = event.data;
      accepted.current = { id: message.id, origin: event.origin };
      setRequestOrigin(event.origin);
      if ((message.action.kind as VaultRoute) !== route) {
        responded.current = true;
        post(message.id, event.origin, { ok: false, code: 'INVALID_REQUEST' });
        setState('invalid');
        return;
      }
      setRequest(message);
      setState('ready');
    };

    window.addEventListener('message', onMessage);
    if (!announced.current) {
      announced.current = true;
      const ready: VaultReady = { protocol: VAULT_PROTOCOL, type: 'ready' };
      opener.postMessage(ready, '*');
    }
    return () => window.removeEventListener('message', onMessage);
  }, [post, route]);

  const confirmOrigin = useCallback((confirmed: string) => {
    if (accepted.current?.origin !== confirmed) return false;
    verified.current = true;
    setOrigin(confirmed);
    return true;
  }, []);

  const respond = useCallback(
    (outcome: VaultOutcome) => {
      if (!accepted.current || responded.current) return;
      responded.current = true;
      // Without a verified origin, only an error code can go out, never data.
      post(accepted.current.id, accepted.current.origin, verified.current || !outcome.ok ? outcome : { ok: false, code: 'UNAUTHORIZED' });
    },
    [post],
  );

  const renew = useCallback(() => {
    const opener = window.opener as Window | null;
    if (!opener || responded.current) return;
    accepted.current = null;
    verified.current = false;
    setRequest(null);
    setOrigin(null);
    setState('connecting');
    const ready: VaultReady = { protocol: VAULT_PROTOCOL, type: 'ready' };
    opener.postMessage(ready, '*');
  }, []);

  return { state, origin, requestOrigin, request, confirmOrigin, respond, renew };
}
