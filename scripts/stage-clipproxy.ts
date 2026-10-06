import {createHash} from 'node:crypto';
import {mkdir, readFile, stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export const CLIPROXY_VERSION = 'v8-sidecar-1';
const projectRoot = join(import.meta.dirname, '..');
const serverDir = join(projectRoot, '..', 'CLIProxyAPI', 'cmd', 'server');
const output = join(projectRoot, 'src-tauri', 'binaries', 'cliproxy-sidecar-x86_64-pc-windows-msvc.exe');

export function buildCliproxyArgs(configPath: string): string[] {
  return ['-config', configPath];
}

function hasGoToolchain(): boolean {
  const result = Bun.spawnSync({cmd: ['go', 'version'], stdout: 'ignore', stderr: 'ignore'});
  return result.success;
}

export async function stageCliproxy(): Promise<void> {
  if (!(await stat(join(serverDir, 'main.go')).catch(() => undefined))?.isFile()) {
    console.log('Skipping cliproxy staging: CLIProxyAPI source not found.');
    return;
  }
  if (!hasGoToolchain()) {
    console.log('Skipping cliproxy staging: Go toolchain not found.');
    return;
  }
  await mkdir(dirname(output), {recursive: true});
  const build = Bun.spawnSync({
    cmd: ['go', 'build', '-buildvcs=false', '-ldflags=-s -w', '-o', output, '.'],
    cwd: serverDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (!build.success) {
    throw new Error(`cliproxy go build failed (exit ${build.exitCode})`);
  }
  const sha = createHash('sha256').update(await readFile(output)).digest('hex');
  console.log(`cliproxy sha256=${sha}`);
}

if (import.meta.main) {
  await stageCliproxy();
}
