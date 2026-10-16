import {build, preview} from 'vite';

export async function withLumenPerformanceServer(task) {
  const configFile = 'vite.performance.config.ts';
  await build({configFile});
  // Preview owns this strict loopback listener. Never reuse an unknown checkout.
  const server = await preview({configFile, preview: {host: '127.0.0.1', port: 1424, strictPort: true, open: false}});
  try {
    return await task('http://127.0.0.1:1424');
  } finally {
    await server.close();
  }
}
