import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: '**/performance.spec.ts',
  // Functional flows and the compositor benchmark share one desktop GPU.
  // Serial execution keeps the high-refresh evidence isolated and repeatable.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    channel: 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
  },
});
