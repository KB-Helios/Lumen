import {defineConfig} from '@playwright/test';

import functionalConfig from './playwright.config.ts';

const url = 'http://127.0.0.1:1424';

export default defineConfig({
  ...functionalConfig,
  testIgnore: [],
  testMatch: '**/performance.spec.ts',
  outputDir: 'test-results/performance',
  // Preserve attached raw samples for CI evidence uploads.
  reporter: [['list'], ['json', {outputFile: 'test-results/performance-results.json'}]],
  use: {...functionalConfig.use, baseURL: url},
  webServer: {
    command: 'bun run build:performance && bun run preview:performance',
    url,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
