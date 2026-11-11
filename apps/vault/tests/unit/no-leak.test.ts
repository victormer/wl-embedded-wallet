import { combineMnemonic } from '@tetherto/wdk-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexEncode } from '@wl-embedded-wallet/core/encoding';
import { openShareB } from '@wl-embedded-wallet/core/envelope';
import { normalizeRecoveryCode, openShareC } from '@wl-embedded-wallet/core/recovery-code';
import { handleWorkerRequest } from '@wl-embedded-wallet/core/signer';
import { openShareA } from '../../server/kms';
import { makeSecrets, makeServer, SET_ID, USER } from './helpers';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
const IDS = { userId: USER, setId: SET_ID };

function describeError(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [String(e), e.message, e.stack, JSON.stringify(e), String(e.cause)].join('\n');
}

describe('no sensitive material in logs or errors', () => {
  beforeEach(() => {
    for (const method of METHODS) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nothing is written to console and responses and errors contain no secrets', async () => {
    const server = makeServer();
    const secrets = makeSecrets();
    const enrolled = await handleWorkerRequest(
      { op: 'enroll', userId: USER, setId: SET_ID, credentialId: 'cred', prf: secrets.prf(), code: secrets.code() },
      server.deps,
    );
    if (!enrolled.ok) throw new Error(enrolled.code);
    const { signed, encB, encC } = enrolled.enrolled!;

    const { shareA } = server.posted[0];
    const shareB = hexEncode(await openShareB(encB, secrets.prf(), IDS));
    const shareC = hexEncode(await openShareC(encC, secrets.code(), IDS));
    const mnemonic = await combineMnemonic([shareA, shareB]);
    const codeNormalized = normalizeRecoveryCode(secrets.codeText);
    const prfHex = hexEncode(secrets.prf());
    const sensitive = [mnemonic, shareA, shareB, shareC, secrets.codeText, codeNormalized, prfHex];

    const outputs: string[] = [JSON.stringify(enrolled)];
    const collect = async (run: () => Promise<unknown>) => {
      try {
        outputs.push(JSON.stringify(await run()));
      } catch (error) {
        outputs.push(describeError(error));
      }
    };

    const bad = (code: string) => code.replace(/^./, code[0] === '0' ? '1' : '0');
    const leakyDeps = {
      ...server.deps,
      fetchShareA: async () => {
        throw new Error(`boom ${mnemonic} ${shareA}`);
      },
    };

    await collect(() => handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, server.deps));
    await collect(() => handleWorkerRequest({ op: 'recover', combo: 'A+C', signed, encC, code: secrets.code() }, server.deps));
    await collect(() => handleWorkerRequest({ op: 'recover', combo: 'B+C', signed, encB, encC, prf: secrets.prf(), code: secrets.code() }, server.deps));
    await collect(() => handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, leakyDeps));
    await collect(() =>
      handleWorkerRequest(
        { op: 'recover', combo: 'A+C', signed, encC, code: new TextEncoder().encode(bad(codeNormalized)) },
        server.deps,
      ),
    );
    await collect(() => handleWorkerRequest({ op: 'recover', combo: 'A+B', signed: { ...signed, signature: '' }, encB, prf: secrets.prf() }, server.deps));
    await collect(() =>
      handleWorkerRequest({ op: 'recover', combo: 'A+B', signed, encB, prf: secrets.prf() }, { ...server.deps, fetchShareA: async () => shareC }),
    );
    await collect(() => handleWorkerRequest({ op: 'export', signed: { ...signed, signature: '' }, encB, prf: secrets.prf() }, server.deps));
    await collect(() => handleWorkerRequest({ op: 'export', signed, encB, prf: secrets.prf() }, leakyDeps));
    await collect(() => openShareB({ ...encB, ct: 'AAAA' }, secrets.prf(), IDS));
    await collect(() => openShareC(encC, new TextEncoder().encode(bad(codeNormalized)), IDS));
    await collect(async () => normalizeRecoveryCode(`${secrets.codeText}-EXTRA`));
    await collect(() => combineMnemonic([shareA, shareA]));
    await collect(() => openShareA({ ...encB }, IDS));

    expect(outputs.length).toBeGreaterThan(10);
    for (const output of outputs) {
      for (const secret of sensitive) expect(output).not.toContain(secret);
    }
    // Successful responses only carry the address; error responses, only the code.
    expect(outputs[1]).toBe(JSON.stringify({ ok: true, address: enrolled.address, owner: enrolled.owner, wdkVersionMismatch: false }));
    expect(outputs[4]).toBe(JSON.stringify({ ok: false, code: 'INTERNAL' }));

    // Successful `export`: the seed goes in the response, and still nothing is written to console.
    const exported = await handleWorkerRequest({ op: 'export', signed, encB, prf: secrets.prf() }, server.deps);
    expect(exported).toMatchObject({ ok: true, mnemonic });

    for (const method of METHODS) expect(console[method]).not.toHaveBeenCalled();
  });
});
