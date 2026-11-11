// Network-free CLI: kit + code → checks owner and Safe, and shows the seed only with `--show-seed`.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { WalletError } from '@wl-embedded-wallet/core/errors';
import { recoverFromKit } from '@wl-embedded-wallet/core/offline';
import { MISMATCH_TEXT, offlineErrorText } from './messages';

const EXIT = { OK: 0, USAGE: 1, FAILED: 2, MISMATCH: 3 };

const USAGE = `Usage: wl-embedded-wallet-recovery <kit.json> [--show-seed] [--code-stdin]

  Uses your kit and your recovery code to check that the owner and the Safe match the kit.
  It does not use the network, your passkey, or the server.

  --show-seed    Shows the seed if everything matches. Without this option, it is never shown.
  --code-stdin   Reads the code from standard input. Without it, prompts on the terminal without echoing it.

  The code is not accepted as an argument: it would end up in the shell history and the process list.
`;

function readFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text.split('\n')[0].trim()));
    process.stdin.on('error', reject);
  });
}

function promptSilently(question: string): Promise<string> {
  process.stderr.write(question);
  // What is typed is not echoed to the screen.
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const reader = createInterface({ input: process.stdin, output: silent, terminal: true });
  return new Promise((resolve) => {
    reader.question('', (answer) => {
      reader.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const paths = argv.filter((arg) => !arg.startsWith('--'));
  const known = new Set(['--show-seed', '--code-stdin']);
  if (paths.length !== 1 || [...flags].some((flag) => !known.has(flag))) {
    process.stderr.write(USAGE);
    return EXIT.USAGE;
  }

  let kitText: string;
  try {
    kitText = readFileSync(paths[0], 'utf8');
  } catch {
    process.stderr.write(`Cannot read ${paths[0]}\n`);
    return EXIT.USAGE;
  }

  const code = flags.has('--code-stdin') ? await readFromStdin() : await promptSilently('Recovery code: ');
  try {
    const result = await recoverFromKit(kitText, code);
    const line = (label: string, derived: string | null, expected: string, matches: boolean) =>
      `${label}: ${derived ?? 'cannot be computed'} (${matches ? 'matches the kit' : `MISMATCH: the kit says ${expected}`})\n`;
    process.stdout.write(line('Owner', result.derivedOwner, result.expectedOwner, result.ownerMatches));
    process.stdout.write(line('Safe', result.derivedSafe, result.expectedSafe, result.safeMatches));
    if (!result.ok) {
      process.stderr.write(`${MISMATCH_TEXT}\n`);
      return EXIT.MISMATCH;
    }
    if (flags.has('--show-seed')) {
      process.stderr.write('Anyone who sees these words controls your funds.\n');
      process.stdout.write(`Seed: ${result.mnemonic}\n`);
    } else {
      process.stderr.write('The seed was not shown. To see it, run again with --show-seed.\n');
    }
    return EXIT.OK;
  } catch (error) {
    process.stderr.write(`${offlineErrorText(error instanceof WalletError ? error.code : 'INTERNAL')}\n`);
    return EXIT.FAILED;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
