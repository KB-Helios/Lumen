import {execFileSync, spawn} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const defaultUrl = 'http://127.0.0.1:1420';
const viteCli = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));

async function isReady(url) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(800)});
    return response.ok;
  } catch {
    return false;
  }
}

function ownsListener(url, child, remainingMs) {
  const port = new URL(url).port || '80';
  const source = `$ProgressPreference='SilentlyContinue'; @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json`;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {encoding: 'utf8', windowsHide: true, timeout: Math.max(1, remainingMs)});
    const owners = [JSON.parse(output)].flat();
    return owners.length > 0 && owners.every((pid) => pid === child.pid);
  } catch {
    return false;
  }
}

async function waitUntilReady(url, child, reuseExistingServer, hasStarted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!reuseExistingServer && child.exitCode !== null) {
      throw new Error(`Lumen development server exited with code ${child.exitCode}.`);
    }
    if (await isReady(url)) {
      if (reuseExistingServer) return;
      // HTTP readiness alone can come from a competing checkout before Vite binds.
      if (hasStarted()) {
        if (!ownsListener(url, child, deadline - Date.now()) || child.exitCode !== null || Date.now() >= deadline) throw new Error('Lumen development server listener is not owned by the spawned child within the startup deadline.');
        return;
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`Lumen development server exited with code ${child.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Lumen development server did not become ready at ${url}.`);
}

async function stopDevelopmentServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (!child.kill()) throw new Error('Lumen development server could not be stopped.');
  await exited;
}

export async function withLumenDevServer(task, url = defaultUrl, {reuseExistingServer = true} = {}) {
  if (!reuseExistingServer && process.platform !== 'win32') throw new Error('Owned Lumen server verification requires Windows.');
  if (await isReady(url)) {
    if (!reuseExistingServer) throw new Error('Lumen development server is already ready; owned startup required.');
    return task(url);
  }

  const target = new URL(url);
  const child = spawn(
    process.execPath,
    [
      viteCli,
      '--host',
      target.hostname,
      '--port',
      target.port,
      '--strictPort',
    ],
    {
      cwd: process.cwd(),
      env: {...process.env, NO_COLOR: '1'},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let serverOutput = '';
  const rememberOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-4000);
  };
  child.stdout.on('data', rememberOutput);
  child.stderr.on('data', rememberOutput);

  try {
    await waitUntilReady(url, child, reuseExistingServer, () => /VITE[^\n]*ready in/.test(serverOutput) && serverOutput.includes(`${url}/`));
    return await task(url);
  } catch (error) {
    if (serverOutput) process.stderr.write(serverOutput);
    throw error;
  } finally {
    await stopDevelopmentServer(child);
  }
}
