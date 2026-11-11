// Copies the real contract bytecode from a public network. Read-only. Run by hand, once.
import { writeFileSync } from 'node:fs';

const RPC = process.env.FIXTURE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACTS = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  senderCreator: '0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C',
  safeProxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  safeL2Singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  safe4337Module: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  safeModuleSetup: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
  multiSend: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
};

const fixture = {};
for (const [name, address] of Object.entries(CONTRACTS)) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  });
  const { result } = await response.json();
  if (!result || result === '0x') throw new Error(`No code at ${name}`);
  fixture[name] = { address, code: result };
}
writeFileSync(new URL('./fixtures/contracts.json', import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`);
console.log(Object.entries(fixture).map(([name, { code }]) => `${name}: ${(code.length - 2) / 2} bytes`).join('\n'));
