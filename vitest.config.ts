import tailwindcss from '@tailwindcss/vite';
import {configDefaults, defineConfig} from 'vitest/config';
import {availableParallelism} from 'node:os';

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'scripts/stage-rivet-engine.test.ts', 'scripts/stage-windows-ai.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
    // Keep DOM and real subprocess fixtures within their existing deadlines on high-core hosts.
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
  },
});
