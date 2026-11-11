// `pnpm --filter ./apps/vault aa:stack`: starts the chains for development and prints the configuration.
import { aaChainsConfig, startAaStack } from './stack.mjs';

const stack = await startAaStack([
  { chainId: 31001, port: 21545, withContracts: true },
  { chainId: 31002, port: 21546, withContracts: true },
  { chainId: 31003, port: 21547, withContracts: false },
]);
console.log(`AA_CHAINS=${JSON.stringify(aaChainsConfig(stack.chains))}`);
console.log(`RPC_ALLOWED_HOSTS=127.0.0.1`);
console.log(`DEMO_CHAINS=${JSON.stringify(stack.chains.map(({ chainId, rpcUrl }) => ({ chainId, name: `Local ${chainId}`, rpcUrl })))}`);
const stop = () => stack.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
