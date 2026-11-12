#!/usr/bin/env node
// Pushes the vault's `AA_CHAINS` from a local JSON file to a Vercel project as a Sensitive production variable, and
// optionally redeploys it. The file never leaves this machine except as that variable, and nothing here prints a URL
// query, header value or policy id: only chain ids, hosts and flags. See docs/DEPLOYMENT.md#vercel-aa-chains.
//
//   node scripts/vercel-aa-chains.mjs [--file .secrets/aa-chains.json] [--check] [--redeploy]
//
// The project and team come from `--project`/`--team` or from `.secrets/vercel.json` ({ "project", "team" }).
// The token comes from VERCEL_TOKEN, or else from the Vercel CLI's own login (`vercel login`).
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.vercel.com';
const NAME = 'AA_CHAINS';
const CHAIN_FIELDS = new Set([
  'name', 'nativeCurrency', 'rpcUrl', 'bundlerUrl', 'bundlerHeaders', 'paymasterUrl', 'paymasterHeaders',
  'paymasterContext', 'sponsorTransactions', 'limits',
]);

function args(argv) {
  const out = { file: '.secrets/aa-chains.json', check: false, redeploy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--redeploy') out.redeploy = true;
    else if (['--file', '--project', '--team'].includes(arg) && argv[i + 1]) out[arg.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function host(value, field, chainId, problems) {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') problems.push(`${chainId}.${field} must be https`);
    return url.host;
  } catch {
    problems.push(`${chainId}.${field} is not a URL`);
    return null;
  }
}

/** Structure only, without values: the vault's own validation still runs at startup and stops it if anything is off. */
export function summarize(raw) {
  let chains;
  try {
    chains = JSON.parse(raw);
  } catch (error) {
    // V8 quotes part of the input in some messages: only the position is shown, as line and column.
    const position = Number(/position (\d+)/.exec(error.message)?.[1]);
    const where = Number.isInteger(position)
      ? ` at line ${raw.slice(0, position).split('\n').length}, column ${position - raw.lastIndexOf('\n', position - 1)}`
      : '';
    return { problems: [`not valid JSON${where}`], rows: [] };
  }
  const problems = [];
  const rows = [];
  if (/<[A-Z_]+>/.test(raw)) problems.push('still has a <PLACEHOLDER> from the example');
  if (typeof chains !== 'object' || chains === null || Array.isArray(chains)) return { problems: ['must be an object keyed by chainId'], rows };
  for (const [chainId, chain] of Object.entries(chains)) {
    if (!/^[1-9][0-9]{0,15}$/.test(chainId)) problems.push(`key "${chainId.slice(0, 20)}" is not a chainId`);
    if (typeof chain !== 'object' || chain === null || Array.isArray(chain)) {
      problems.push(`${chainId} must be an object`);
      continue;
    }
    for (const key of Object.keys(chain)) if (!CHAIN_FIELDS.has(key)) problems.push(`${chainId}.${key.slice(0, 30)} is not a known field`);
    if (typeof chain.bundlerUrl !== 'string') problems.push(`${chainId}.bundlerUrl is required`);
    if (chain.sponsorTransactions !== undefined && typeof chain.sponsorTransactions !== 'boolean') problems.push(`${chainId}.sponsorTransactions must be true or false`);
    if (chain.sponsorTransactions === true && typeof chain.paymasterUrl !== 'string') problems.push(`${chainId}.sponsorTransactions needs paymasterUrl`);
    rows.push({
      chainId,
      name: typeof chain.name === 'string' ? chain.name : '',
      rpc: host(chain.rpcUrl, 'rpcUrl', chainId, problems) ?? '(from token)',
      bundler: host(chain.bundlerUrl, 'bundlerUrl', chainId, problems) ?? '-',
      paymaster: host(chain.paymasterUrl, 'paymasterUrl', chainId, problems) ?? '-',
      policy: chain.paymasterContext?.sponsorshipPolicyId ? 'yes' : 'no',
      transactions: chain.sponsorTransactions === true ? 'sponsored' : 'paid by the Safe',
    });
  }
  return { problems, rows };
}

function vercelToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const dirs = platform() === 'darwin'
    ? [join(homedir(), 'Library/Application Support/com.vercel.cli')]
    : [join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'com.vercel.cli')];
  for (const dir of dirs) {
    const file = join(dir, 'auth.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).token;
  }
  throw new Error('No Vercel token: set VERCEL_TOKEN or run `vercel login`.');
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Vercel API ${method} ${path.split('?')[0]}: ${response.status} ${json.error?.code ?? ''}`);
  return json;
}

async function main() {
  const options = args(process.argv.slice(2));
  const local = existsSync('.secrets/vercel.json') ? JSON.parse(readFileSync('.secrets/vercel.json', 'utf8')) : {};
  const project = options.project ?? local.project;
  const team = options.team ?? local.team;
  if (!existsSync(options.file)) throw new Error(`${options.file} does not exist (start from deploy/vercel/aa-chains.example.json).`);

  const raw = readFileSync(options.file, 'utf8');
  const { problems, rows } = summarize(raw);
  if (rows.length) console.table(rows);
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log(`✓ ${options.file}: ${rows.length} chains, structure valid.`);
  if (options.check) return;
  if (!project || !team) throw new Error('Missing --project/--team (or .secrets/vercel.json).');

  const token = vercelToken();
  const { id: teamId } = await api(token, 'GET', `/v2/teams/${encodeURIComponent(team)}`);
  const value = JSON.stringify(JSON.parse(raw));
  const result = await api(token, 'POST', `/v10/projects/${encodeURIComponent(project)}/env?upsert=true&teamId=${teamId}`, [
    { key: NAME, value, type: 'sensitive', target: ['production'] },
  ]);
  if (result.failed?.length) throw new Error(`Vercel refused ${NAME}: ${result.failed.map((f) => f.error?.code).join(', ')}`);
  console.log(`✓ ${NAME} saved in ${project} (Production, Sensitive).`);

  if (!options.redeploy) {
    console.log('It takes effect on the next deployment: run again with --redeploy, or redeploy from Vercel.');
    return;
  }
  const { deployments } = await api(token, 'GET', `/v6/deployments?projectId=${encodeURIComponent(project)}&teamId=${teamId}&target=production&state=READY&limit=1`);
  if (!deployments?.length) throw new Error('No ready production deployment to redeploy.');
  const deployment = await api(token, 'POST', `/v13/deployments?teamId=${teamId}`, {
    name: project,
    deploymentId: deployments[0].uid,
    target: 'production',
  });
  console.log(`✓ Redeploying ${project}: https://${deployment.url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
