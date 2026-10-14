import tailwindcss from '@tailwindcss/vite';
import {configDefaults, defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'scripts/stage-rivet-engine.test.ts', 'scripts/stage-windows-ai.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
  },
});
