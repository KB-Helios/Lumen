import {createHash} from 'node:crypto';
import {copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve} from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const workerRoot = join(projectRoot, 'workers', 'computer-use-preview');
const virtualEnvironment = join(workerRoot, '.venv');
const virtualPython = join(virtualEnvironment, 'Scripts', 'python.exe');
const buildRoot = join(workerRoot, '.build');
const buildIdPath = join(workerRoot, '.build-id');
const name = 'lumen-computer-use-x86_64-pc-windows-msvc';
const binariesRoot = join(projectRoot, 'src-tauri', 'binaries');
const output = join(binariesRoot, `${name}.exe`);
const runtime = join(binariesRoot, 'computer-use-runtime');
const inventoryPath = join(buildRoot, 'staged-runtime-inventory.json');
const nativePins = {
  'cua_driver_sdk.dll': '1dae9015f81bb81b093b12181a1970b0a5cb1c2c992684afc1c629bdfc41728d',
  'bin/cua-driver.exe': '77f5cac754b42b6a8bae126414fc8f7487432ace93466967965188e24e9e53fb',
  'bin/cua-driver-uia.exe': '1c737385f3cf008240ca8ff2a58ffc6810ebd382c14bd3dccb87ccbdc4ced556',
} as const;
const inputs = [
  'worker.py', 'browser_executor.py', 'window_executor.py', 'requirements.txt',
  'requirements-build.txt', 'requirements.lock', 'LICENSE', 'NOTICE.md',
  'third-party/cua-driver-LICENSE.txt',
] as const;

type RuntimeInventory = {version: 1; buildId: string; files: Record<string, {sha256: string; size: number}>};

async function runtimeFiles(root: string) {
  const files = [`${name}.exe`];
  async function visit(directory: string) {
    for (const entry of await readdir(join(root, directory), {withFileTypes: true})) {
      const child = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Runtime resource must not be a reparse link');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error('Runtime resource is not a regular file');
    }
  }
  await visit('computer-use-runtime');
  return files.sort();
}

export async function generateRuntimeInventory(root: string, buildId: string): Promise<RuntimeInventory> {
  const canonicalRoot = await realpath(root);
  const files: RuntimeInventory['files'] = {};
  for (const file of await runtimeFiles(canonicalRoot)) {
    const resolvedFile = await realpath(join(canonicalRoot, file));
    const child = relative(canonicalRoot, resolvedFile);
    if (isAbsolute(child) || child.startsWith('..')) throw new Error('Runtime resource escapes its fixed directory');
    const data = await readFile(resolvedFile);
    files[file] = {sha256: createHash('sha256').update(data).digest('hex'), size: data.length};
  }
  return {version: 1, buildId, files};
}

export async function verifyRuntimeInventory(root: string, expected: unknown, buildId: string) {
  try {
    const actual = await generateRuntimeInventory(root, buildId);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function verifyPinnedNativeResources(root: string) {
  for (const [file, expected] of Object.entries(nativePins)) {
    const data = await readFile(join(root, file));
    if (createHash('sha256').update(data).digest('hex') !== expected) {
      throw new Error('Cua native resource does not match the checksum-pinned 0.34.0 wheel');
    }
  }
}

function spawn(command: string[], cwd = projectRoot, quiet = false) {
  return Bun.spawnSync({cmd: command, cwd, stdout: quiet ? 'pipe' : 'inherit',
    stderr: quiet ? 'pipe' : 'inherit',
    env: {...process.env, PYINSTALLER_CONFIG_DIR: join(buildRoot, 'pyinstaller-cache')}});
}

function run(command: string[], cwd = workerRoot) {
  const result = spawn(command, cwd);
  if (!result.success) throw new Error(`Worker build command failed (${result.exitCode})`);
}

function probeUv(args: string[]) {
  try {
    return spawn(['uv', ...args], workerRoot, true);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
        && 'path' in error && error.path === 'uv') return undefined;
    throw error;
  }
}

function pythonVersion(binary: string) {
  const result = spawn([binary, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], projectRoot, true);
  return result.success ? result.stdout.toString().trim() : '';
}

async function removeWorkerDirectory(path: string) {
  const parent = await realpath(workerRoot);
  const target = resolve(path);
  const resolvedTarget = await realpath(target).catch(() => target);
  const child = relative(parent, resolvedTarget);
  if (isAbsolute(child) || child.startsWith('..') || !child ||
      ![virtualEnvironment, join(buildRoot, 'work'), join(buildRoot, 'dist')].includes(target)) {
    throw new Error('Worker cleanup target is outside the fixed build/cache directories');
  }
  await rm(target, {recursive: true, force: true});
}

async function buildId() {
  const hash = createHash('sha256');
  hash.update('fixed-executor-v1;python=3.11;onedir;contents=computer-use-runtime');
  hash.update(await readFile(import.meta.filename));
  for (const input of inputs) {
    hash.update(input);
    hash.update(await readFile(join(workerRoot, input)));
  }
  return hash.digest('hex');
}

async function ensureVirtualEnvironment() {
  if ((await stat(virtualPython).catch(() => undefined))?.isFile() && pythonVersion(virtualPython) === '3.11') return;
  await removeWorkerDirectory(virtualEnvironment);
  const configuredPython = process.env.LUMEN_PYTHON?.trim();
  const managedPython = configuredPython ? undefined : probeUv(['python', 'find', '3.11']);
  const managedPath = managedPython?.success ? managedPython.stdout.toString().trim() : '';
  const interpreter = configuredPython || managedPath || 'python';
  if (pythonVersion(interpreter) !== '3.11') throw new Error('Computer Use staging requires Python 3.11');
  run([interpreter, '-m', 'venv', virtualEnvironment]);
}

function readHealth(binary: string, source = false) {
  const result = Bun.spawnSync({cmd: source ? [binary, join(workerRoot, 'worker.py'), '--health'] : [binary, '--health'],
    cwd: workerRoot, stdout: 'pipe', stderr: 'ignore', timeout: 20000});
  if (!result.success) throw new Error('Computer Use health did not finish successfully');
  const value: unknown = JSON.parse(result.stdout.toString().trim());
  if (!value || typeof value !== 'object') throw new Error('Invalid worker health payload');
  const health = value as {ready: boolean; edgeAvailable: boolean; desktopAvailable: boolean};
  if ([health.ready, health.edgeAvailable, health.desktopAvailable].some(flag => typeof flag !== 'boolean')
      || health.ready !== (health.edgeAvailable || health.desktopAvailable)) throw new Error('Invalid worker health routes');
  return health;
}

async function runtimePresent() {
  return (await Promise.all([
    output, join(runtime, 'cua_driver', 'cua_driver_sdk.dll'),
    join(runtime, 'cua_driver', 'bin', 'cua-driver.exe'),
    join(runtime, 'cua_driver', 'bin', 'cua-driver-uia.exe'),
  ].map(async path => (await stat(path).catch(() => undefined))?.isFile()))).every(Boolean);
}

export async function stageComputerUse() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The executor wheel is pinned for Windows x64');
  await ensureVirtualEnvironment();
  const expectedBuildId = await buildId();
  const storedInventory: unknown = await readFile(inventoryPath, 'utf8').then(JSON.parse).catch(() => undefined);
  if (await readFile(buildIdPath, 'utf8').catch(() => '') === expectedBuildId && await runtimePresent()
      && await verifyRuntimeInventory(binariesRoot, storedInventory, expectedBuildId)) {
    await verifyPinnedNativeResources(join(runtime, 'cua_driver'));
    if (JSON.stringify(readHealth(virtualPython, true)) === JSON.stringify(readHealth(output))) {
      console.log('Fixed Computer Use executor is already staged.');
      return;
    }
  }
  const hasUv = probeUv(['--version'])?.success;
  if (hasUv) {
    run(['uv', 'pip', 'install', '--python', virtualPython, '--require-hashes', '--only-binary', ':all:',
      '-r', join(workerRoot, 'requirements.lock')]);
  } else {
    run([virtualPython, '-m', 'ensurepip']);
    run([virtualPython, '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes',
      '--only-binary', ':all:', '-r', join(workerRoot, 'requirements.lock')]);
  }
  await verifyPinnedNativeResources(join(virtualEnvironment, 'Lib', 'site-packages', 'cua_driver'));
  await removeWorkerDirectory(join(buildRoot, 'work'));
  await removeWorkerDirectory(join(buildRoot, 'dist'));
  await mkdir(buildRoot, {recursive: true});
  await mkdir(binariesRoot, {recursive: true});
  run([virtualPython, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--contents-directory', 'computer-use-runtime', '--name', name,
    '--collect-all', 'cua_driver', '--collect-all', 'playwright',
    '--add-data', `${join(workerRoot, 'NOTICE.md')};.`,
    '--add-data', `${join(workerRoot, 'LICENSE')};.`,
    '--add-data', `${join(workerRoot, 'third-party')};third-party`,
    '--distpath', join(buildRoot, 'dist'), '--workpath', join(buildRoot, 'work'),
    '--specpath', buildRoot, join(workerRoot, 'worker.py')]);
  const generated = join(buildRoot, 'dist', name);
  await verifyPinnedNativeResources(join(generated, 'computer-use-runtime', 'cua_driver'));
  const generatedInventory = await generateRuntimeInventory(generated, expectedBuildId);
  // Copy only generated build artifacts. Never recursively delete the shared binaries folder.
  const runtimeResolved = await realpath(runtime).catch(() => resolve(runtime));
  if (runtimeResolved !== resolve(runtime)) throw new Error('Worker runtime destination must not be a reparse link');
  const runtimeChild = relative(await realpath(binariesRoot), runtimeResolved);
  if (runtimeChild !== 'computer-use-runtime') throw new Error('Worker runtime cleanup escapes its fixed staged directory');
  await rm(runtimeResolved, {recursive: true, force: true});
  await cp(join(generated, 'computer-use-runtime'), runtime, {recursive: true, force: true});
  await copyFile(join(generated, `${name}.exe`), output);
  if (!await runtimePresent()) throw new Error('Packaged executor native resources are missing');
  if (!await verifyRuntimeInventory(binariesRoot, generatedInventory, expectedBuildId)) {
    throw new Error('Staged runtime is modified, missing resources, or contains stale unexpected files');
  }
  const sourceHealth = readHealth(virtualPython, true);
  const packagedHealth = readHealth(output);
  if (JSON.stringify(sourceHealth) !== JSON.stringify(packagedHealth)) throw new Error('Source and packaged worker routes disagree');
  await writeFile(buildIdPath, expectedBuildId);
  await writeFile(inventoryPath, JSON.stringify(generatedInventory));
  console.log('Staged fixed Computer Use executor and matching native runtime resources.');
}

if (import.meta.main) await stageComputerUse();
