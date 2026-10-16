import {defineConfig, mergeConfig} from 'vite';

import appConfig from './vite.config.ts';

// Dedicated test output: never used by Tauri's release build. Keep fixture
// routes and diagnostics while React/JSX use production profiling code.
export default defineConfig(async () => mergeConfig(await appConfig(), {
  mode: 'production',
  resolve: {alias: [{find: /^react-dom\/client$/, replacement: 'react-dom/profiling'}]},
  define: {'import.meta.env.DEV': 'true', 'process.env.NODE_ENV': '"production"'},
  build: {outDir: 'node_modules/.cache/lumen-performance', emptyOutDir: true},
}));
