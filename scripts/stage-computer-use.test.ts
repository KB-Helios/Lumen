import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const bun = spawnSync('bun', ['-e', 'console.log(process.execPath)'], {encoding: 'utf8', windowsHide: true}).stdout.trim();

async function cleanFixture(directory: string) {
  const canonical = await realpath(directory);
  if (dirname(canonical) !== await realpath(tmpdir()) || !canonical.split(/[\\/]/).at(-1)?.startsWith('lumen-worker-stage-')) {
    throw new Error('Unsafe worker fixture cleanup path');
  }
  await rm(canonical, {recursive: true, force: true});
}

describe('computer-use staging without optional uv', () => {
  it.each([false, true])('creates Python 3.11 and uses pip with configured Python=%s', async configured => {
    const directory = await mkdtemp(join(tmpdir(), 'lumen-worker-stage-'));
    try {
      const scripts = join(directory, 'scripts');
      const worker = join(directory, 'workers', 'computer-use-preview');
      await mkdir(scripts, {recursive: true});
      await mkdir(join(worker, 'third-party'), {recursive: true});
      await copyFile(join(projectRoot, 'scripts', 'stage-computer-use.ts'), join(scripts, 'stage-computer-use.ts'));
      for (const input of ['worker.py', 'browser_executor.py', 'window_executor.py', 'requirements.txt',
        'requirements-build.txt', 'requirements.lock', 'LICENSE', 'NOTICE.md', 'third-party/cua-driver-LICENSE.txt']) {
        await writeFile(join(worker, input), '');
      }
      const stagedPython = join(projectRoot, 'workers', 'computer-use-preview', '.venv', 'Scripts', 'python.exe');
      const knownPython = process.env.LUMEN_PYTHON || ((await stat(stagedPython).catch(() => undefined))?.isFile() ? stagedPython : 'python');
      const base = spawnSync(knownPython, ['-c', 'import sys; print(sys._base_executable)'], {encoding: 'utf8', windowsHide: true});
      expect(base.status, base.stderr || base.error?.message).toBe(0);
      const python = base.stdout.trim();
      const env: NodeJS.ProcessEnv = {...process.env, PATH: `${dirname(python)};${join(process.env.SystemRoot!, 'System32')}`,
        HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
        PIP_CONFIG_FILE: 'NUL', PIP_NO_INDEX: '1', PIP_CACHE_DIR: join(directory, 'pip-cache')};
      delete env.LUMEN_PYTHON;
      if (configured) env.LUMEN_PYTHON = python;
      // Execute the actual Bun script against an isolated worker tree. Empty
      // requirements prevent network use; missing pinned DLL stops packaging.
      const result = spawnSync(bun, [join(scripts, 'stage-computer-use.ts')],
        {cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cua_driver_sdk.dll');
      const virtualPython = join(worker, '.venv', 'Scripts', 'python.exe');
      const version = spawnSync(virtualPython, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
        {env, encoding: 'utf8', windowsHide: true});
      expect(version.stdout.trim()).toBe('3.11');
      const pip = spawnSync(virtualPython, ['-m', 'pip', '--version'], {env, encoding: 'utf8', windowsHide: true});
      expect(pip.status).toBe(0);
      expect(result.stdout).toContain('Requirement already satisfied: pip');
      expect(await readFile(join(worker, 'requirements.lock'), 'utf8')).toBe('');
    } finally {
      await cleanFixture(directory);
    }
  }, 90_000);
});
