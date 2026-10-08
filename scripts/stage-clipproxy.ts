import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

// Official router-for-me/CLIProxyAPI release 406858430, Windows amd64 asset
// 621918653. Archive SHA-256 matches GitHub's digest and checksums.txt.
// Executable SHA-256 is derived from that verified archive.
export const CLIPROXY_VERSION = 'v8.0.21';
export const CLIPROXY_ARCHIVE_SHA256 = 'eaf609497cd1b01256370847adcf4c79469010e5918a24b9538871d8d266f105';
export const CLIPROXY_EXECUTABLE_SHA256 = '417e118bd81af7a8a1c20c3fa437f2c763d405e13e41924e2b97d18968b5f87a';
const projectRoot = join(import.meta.dirname, '..');
const output = join(projectRoot, 'src-tauri', 'binaries', 'cliproxy-sidecar-x86_64-pc-windows-msvc.exe');

export function buildCliproxyArgs(configPath: string): string[] {
  return ['-config', configPath];
}

interface StageOptions {
  output?: string;
  url?: string;
  archiveSha256?: string;
  executableSha256?: string;
}

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function cleanStaging(temporary: string, parent: string) {
  if (dirname(temporary) !== parent || !temporary.startsWith(join(parent, '.stage-cliproxy-'))) {
    throw new Error('Unsafe CLIProxyAPI staging cleanup path');
  }
  await rm(temporary, {recursive: true, force: true});
}

export async function stageCliproxy(options: StageOptions = {}): Promise<void> {
  const destination = resolve(options.output ?? output);
  const archiveSha = options.archiveSha256 ?? CLIPROXY_ARCHIVE_SHA256;
  const executableSha = options.executableSha256 ?? CLIPROXY_EXECUTABLE_SHA256;
  if ((await stat(destination).catch(() => undefined))?.isFile() && digest(await readFile(destination)) === executableSha) {
    console.log(`CLIProxyAPI ${CLIPROXY_VERSION} already staged and verified.`);
    return;
  }
  await mkdir(dirname(destination), {recursive: true});
  const temporary = await mkdtemp(join(dirname(destination), '.stage-cliproxy-'));
  try {
    const response = await fetch(options.url ?? `https://github.com/router-for-me/CLIProxyAPI/releases/download/${CLIPROXY_VERSION}/CLIProxyAPI_8.0.21_windows_amd64.zip`);
    if (!response.ok) throw new Error(`CLIProxyAPI download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (digest(bytes) !== archiveSha) throw new Error('CLIProxyAPI archive checksum mismatch');
    const archivePath = join(temporary, 'proxy.zip');
    await writeFile(archivePath, bytes);
    const extracted = spawnSync('tar', ['-xf', archivePath, '-C', temporary, 'cli-proxy-api.exe'], {encoding: 'utf8', windowsHide: true});
    if (extracted.status !== 0) throw new Error(`CLIProxyAPI extraction failed: ${extracted.error?.message ?? extracted.stderr}`);
    const executable = join(temporary, 'cli-proxy-api.exe');
    if (digest(await readFile(executable)) !== executableSha) throw new Error('CLIProxyAPI executable checksum mismatch');
    await rename(executable, destination);
    console.log(`Staged CLIProxyAPI ${CLIPROXY_VERSION} (${executableSha}).`);
  } finally {
    await cleanStaging(temporary, dirname(destination));
  }
}

if (import.meta.main) {
  await stageCliproxy();
}
