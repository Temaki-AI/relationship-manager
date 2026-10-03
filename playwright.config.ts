import { defineConfig, devices } from '@playwright/test';

const port = process.env.BONDS_E2E_PORT || '3111';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['line']],
  use: {
    baseURL,
    channel: process.env.BONDS_E2E_BROWSER_CHANNEL,
    contextOptions: {
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `${baseURL}/api/health/ready`,
    reuseExistingServer: process.env.BONDS_E2E_REUSE_SERVER === 'true',
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
