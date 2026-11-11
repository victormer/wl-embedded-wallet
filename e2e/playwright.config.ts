import { defineConfig } from '@playwright/test';

// `pnpm test:e2e:image` adds the tests for the image itself.
const imageMode = process.env.E2E_VAULT_IMAGE === '1';

export default defineConfig({
  testDir: '.',
  testMatch: imageMode ? /tests(-image)?\/.*\.spec\.ts/ : /tests\/.*\.spec\.ts/,
  globalSetup: './support/global-setup.ts',
  // The chains and the bundler are shared, and one UserOperation at a time keeps the bundler nonce consistent.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    browserName: 'chromium',
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
  },
});
