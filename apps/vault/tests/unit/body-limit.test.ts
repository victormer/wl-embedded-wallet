import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST as postHandoff } from '../../app/api/auth/handoff/route';
import { POST as postRecovery } from '../../app/api/recovery/passkey/route';
import { POST as postShares } from '../../app/api/shares/route';
import { hexDecode, sha256Hex } from '@wl-embedded-wallet/core/encoding';
import type { RegistrationJson } from '@wl-embedded-wallet/core/types';
import { MAX_JSON_BODY_BYTES, readJson } from '../../server/http';
import { APP_ORIGIN, openSession, ORIGIN, req, sharesBody, useRouteEnv } from './route-harness';

useRouteEnv();

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHUNK = 16 * 1024;

function post(init: { body?: BodyInit; headers?: Record<string, string> }): NextRequest {
  // `duplex` is required by undici for a stream body, but not in the DOM types.
  return new NextRequest(`${ORIGIN}/api/test`, { method: 'POST', duplex: 'half', ...init } as ConstructorParameters<typeof NextRequest>[1]);
}

/** JSON object of exactly `size` bytes. */
function jsonOfSize(size: number): string {
  const frame = '{"pad":""}';
  return `{"pad":"${'a'.repeat(size - frame.length)}"}`;
}

/** Endless body of `CHUNK`-byte chunks that counts how much of it was pulled. */
function endlessStream() {
  const state = { pulls: 0, cancelled: false };
  const chunk = new TextEncoder().encode('a'.repeat(CHUNK));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function expectTooLarge(result: unknown) {
  expect(result).toBeInstanceOf(NextResponse);
  const response = result as NextResponse;
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
}

describe('readJson body limit', () => {
  it('rejects a declared Content-Length above the cap before reading the body', async () => {
    const declared = String(MAX_JSON_BODY_BYTES + 1);
    await expectTooLarge(await readJson(post({ body: '{}', headers: { 'content-length': declared } })));
    await expectTooLarge(await readJson(post({ headers: { 'content-length': declared } })));
  });

  it('rejects a streamed body above the cap without a Content-Length and stops reading early', async () => {
    const { stream, state } = endlessStream();
    await expectTooLarge(await readJson(post({ body: stream })));
    expect(state.cancelled).toBe(true);
    // The cap is 8 chunks: the 9th exceeds it, plus at most what the stream queues ahead.
    expect(state.pulls).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES / CHUNK + 3);
  });

  it('parses a body of exactly the cap and rejects one byte more', async () => {
    const atCap = jsonOfSize(MAX_JSON_BODY_BYTES);
    expect(new TextEncoder().encode(atCap).byteLength).toBe(MAX_JSON_BODY_BYTES);
    const parsed = await readJson(post({ body: atCap }));
    expect(parsed).toEqual({ pad: 'a'.repeat(MAX_JSON_BODY_BYTES - 10) });
    await expectTooLarge(await readJson(post({ body: jsonOfSize(MAX_JSON_BODY_BYTES + 1) })));
  });

  it('keeps returning null for anything that is not a JSON object', async () => {
    for (const body of ['not json', '[1,2]', 'null', '"text"', '42', '']) {
      expect(await readJson(post({ body }))).toBeNull();
    }
    expect(await readJson(post({}))).toBeNull();
    // Like `request.json()`: a UTF-8 BOM is stripped.
    expect(await readJson(post({ body: '﻿{"a":"é"}' }))).toEqual({ a: 'é' });
  });
});

describe('body limit on the routes', () => {
  it('POST /api/auth/handoff rejects an oversized body with 413', async () => {
    const response = await postHandoff(req('/api/auth/handoff', { body: { token: 'x'.repeat(MAX_JSON_BODY_BYTES), origin: APP_ORIGIN } }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
  });

  it('POST /api/recovery/passkey rejects an oversized body with 413', async () => {
    const response = await postRecovery(req('/api/recovery/passkey', { body: { assertion: { id: 'x'.repeat(MAX_JSON_BODY_BYTES) } } }));
    expect(response.status).toBe(413);
  });

  it('POST /api/shares accepts a registration with every field at its validator limit', async () => {
    const cookie = await openSession('alice');
    const id = 'A'.repeat(1024);
    const registration = {
      id,
      rawId: id,
      type: 'public-key',
      response: { clientDataJSON: 'A'.repeat(8192), attestationObject: 'A'.repeat(65536), transports: ['internal', 'hybrid'] },
      clientExtensionResults: { credProps: { rk: true } },
    } as RegistrationJson;
    const body = await sharesBody('alice', ADDRESS, { credentialId: id, registration });
    for (const envelope of [body.encB, body.encC]) {
      envelope.salt = 'A'.repeat(4096);
      envelope.iv = 'A'.repeat(4096);
      envelope.ct = 'A'.repeat(4096);
    }
    body.shareA = 'ab'.repeat(128);
    body.shareDigests.A = await sha256Hex(hexDecode(body.shareA));
    // Near the largest body the validators allow, so the cap keeps a margin over it.
    expect(JSON.stringify(body).length).toBeGreaterThan(100 * 1024);
    const response = await postShares(req('/api/shares', { cookie, body }));
    expect(response.status).not.toBe(413);
    // Read and validated: it only fails at the last step, on the fake attestation.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'CREDENTIAL_INVALID' });
  });
});
