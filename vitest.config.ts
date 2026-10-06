import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
  },
});
