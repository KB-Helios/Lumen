import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri/target',
      'src-tauri/binaries',
      'workers/**/.venv',
      'workers/**/.build',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        AbortSignal: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        PointerEvent: 'readonly',
        process: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        ResizeObserver: 'readonly',
      },
    },
  },
);
