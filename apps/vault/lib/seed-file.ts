/** Generated and downloaded on the spot. The text is not kept in any state. */
export function downloadSeedFile(mnemonic: string, address: string, derivationPath: string): void {
  const text = [
    'Your wallet seed',
    '',
    mnemonic,
    '',
    `Address: ${address}`,
    `Derivation path: ${derivationPath}`,
    '',
    'Whoever has this file controls your funds. Store it offline and do not share it.',
    'Rotating the shares does not change this seed: if it leaks, create a new wallet and move the funds.',
    '',
  ].join('\n');
  downloadText(text, `wl-embedded-wallet-seed-${address.slice(2, 10).toLowerCase()}.txt`, 'text/plain');
}

export function downloadText(text: string, fileName: string, type: string): void {
  downloadBlob(new Blob([text], { type }), fileName);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
