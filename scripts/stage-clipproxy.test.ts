import { describe, it, expect } from "vitest";
import { buildCliproxyArgs } from "./stage-clipproxy.js";
import {stageCliproxy} from './stage-clipproxy';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const archive = Buffer.from('UEsDBBQAAAAAAGCeSF2NyacLEgAAABIAAAARAAAAY2xpLXByb3h5LWFwaS5leGVmaXh0dXJlIGV4ZWN1dGFibGVQSwECFAAUAAAAAABgnkhdjcmnCxIAAAASAAAAEQAAAAAAAAAAAAAAgAEAAAAAY2xpLXByb3h5LWFwaS5leGVQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

// Vitest workers use Node even when launched by Bun. Exercise the staging
// filesystem and fetch behavior in the runtime that actually stages releases.
async function stageInBun(options: Parameters<typeof stageCliproxy>[0]) {
  const source = pathToFileURL(join(import.meta.dirname, 'stage-clipproxy.ts')).href;
  const script = `import {stageCliproxy} from ${JSON.stringify(source)};
    try { await stageCliproxy(${JSON.stringify(options)}); }
    catch(error) { console.error(error.message); process.exitCode = 1; }`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', ['-e', script], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let error = '';
    child.stderr.on('data', data => {error += data.toString();});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  });
}

async function cleanFixture(directory: string) {
  if (!directory.startsWith(join(tmpdir(), 'lumen-proxy-stage-'))) throw new Error('Unsafe fixture path');
  await rm(directory, {recursive: true, force: true});
}

describe("stage-clipproxy", () => {
  it('bounds a stalled body after headers and preserves the previous verified output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-proxy-stage-'));
    const output = join(directory, 'proxy.exe');
    const previous = 'previous trusted binary';
    const previousSha = digest(previous);
    await writeFile(output, previous);
    let headersSent = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, {'Content-Length': archive.length});
      response.write(archive.subarray(0, 8));
      headersSent = true;
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    const watchdog = setTimeout(() => server.closeAllConnections(), 1500);
    const startedAt = performance.now();
    try {
      await expect(stageInBun({output, url: `http://127.0.0.1:${address.port}/stalled.zip`,
        archiveSha256: digest(archive), executableSha256: digest('fixture executable'),
        downloadTimeoutMs: 100})).rejects.toThrow(/timed out/i);
      expect(headersSent).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(digest(await readFile(output))).toBe(previousSha);
      expect(await readdir(directory)).toEqual(['proxy.exe']);
      // The retained output still passes the normal checksum short circuit.
      await stageInBun({output, executableSha256: previousSha});
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await cleanFixture(directory);
    }
  }, 3000);

  it.each(['archive', 'executable'] as const)('preserves the previous output on a bad %s checksum', async (badChecksum) => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-proxy-stage-'));
    const output = join(directory, 'proxy.exe');
    await writeFile(output, 'previous trusted binary');
    const server = createServer((_request, response) => response.end(archive));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    try {
      await expect(stageInBun({
        output,
        url: `http://127.0.0.1:${address.port}/proxy.zip`,
        archiveSha256: badChecksum === 'archive' ? '0'.repeat(64) : digest(archive),
        executableSha256: badChecksum === 'executable' ? '0'.repeat(64) : digest('fixture executable'),
      })).rejects.toThrow(/checksum mismatch/i);
      expect(await readFile(output, 'utf8')).toBe('previous trusted binary');
    } finally {
      server.close();
      await cleanFixture(directory);
    }
  });

  it.each([false, true])('stages verified output with an existing destination=%s', async existing => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-proxy-stage-'));
    const output = join(directory, 'proxy.exe');
    if (existing) await writeFile(output, 'previous trusted binary');
    const server = createServer((_request, response) => response.end(archive));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    try {
      await stageInBun({output, url: `http://127.0.0.1:${address.port}/proxy.zip`, archiveSha256: digest(archive), executableSha256: digest('fixture executable')});
      expect(await readFile(output, 'utf8')).toBe('fixture executable');
    } finally {
      server.close();
      await cleanFixture(directory);
    }
  });

  it("pins loopback config path", () => {
    const args = buildCliproxyArgs("C:\\Lumen\\cliproxy\\config.yaml");
    expect(args).toEqual(["-config", "C:\\Lumen\\cliproxy\\config.yaml"]);
  });
});
