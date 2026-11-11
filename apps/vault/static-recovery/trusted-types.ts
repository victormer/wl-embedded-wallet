// Must run first: `new Worker` needs this policy under `require-trusted-types-for 'script'`.
const scope = window as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown } };

scope.trustedTypes?.createPolicy('default', {
  createScriptURL(value) {
    const url = new URL(value, document.baseURI);
    if (url.origin === location.origin && url.pathname.endsWith('/recovery-worker.js')) return value;
    throw new TypeError('script URL blocked');
  },
});
