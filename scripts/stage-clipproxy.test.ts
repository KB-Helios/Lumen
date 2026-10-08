import { describe, it, expect } from "vitest";
import { buildCliproxyArgs } from "./stage-clipproxy.js";
import {stageCliproxy} from './stage-clipproxy';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const archive = Buffer.from('UEsDBBQAAAAAAGCeSF2NyacLEgAAABIAAAARAAAAY2xpLXByb3h5LWFwaS5leGVmaXh0dXJlIGV4ZWN1dGFibGVQSwECFAAUAAAAAABgnkhdjcmnCxIAAAASAAAAEQAAAAAAAAAAAAAAgAEAAAAAY2xpLXByb3h5LWFwaS5leGVQSwUGAAAAAAEAAQA/AAAAQQAAAAAA', 'base64');
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

async function cleanFixture(directory: string) {
  if (!directory.startsWith(join(tmpdir(), 'lumen-proxy-stage-'))) throw new Error('Unsafe fixture path');
  await rm(directory, {recursive: true, force: true});
}

describe("stage-clipproxy", () => {
  it.each(['archive', 'executable'] as const)('preserves the previous output on a bad %s checksum', async (badChecksum) => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-proxy-stage-'));
    const output = join(directory, 'proxy.exe');
    await writeFile(output, 'previous trusted binary');
    const server = createServer((_request, response) => response.end(archive));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    try {
      await expect(stageCliproxy({
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

  it('stages a verified archive and executable without a sibling source or Go toolchain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-proxy-stage-'));
    const output = join(directory, 'proxy.exe');
    const server = createServer((_request, response) => response.end(archive));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as {port: number};
    try {
      await stageCliproxy({output, url: `http://127.0.0.1:${address.port}/proxy.zip`, archiveSha256: digest(archive), executableSha256: digest('fixture executable')});
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
