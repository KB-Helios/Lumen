/** Publish a fixed stable helper. This never installs models or identity packages. */
import {cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

const workspace = resolve(import.meta.dir, '..');
const worker = join(workspace, 'workers', 'windows-ai');

function ownedTarget(root: string, target: string) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const child = relative(absoluteRoot, absoluteTarget);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Unsafe Windows AI staging target.');
  return absoluteTarget;
}

/** Validate an existing directory and its ancestors without scanning retained siblings. */
export async function verifyOwnedDirectory(root: string, target: string) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = ownedTarget(root, target);
  const canonicalRoot = await realpath(absoluteRoot);
  for (let path = absoluteTarget; ; path = resolve(path, '..')) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Windows AI staging refuses reparse links.');
    if (!info.isDirectory()) throw new Error('Windows AI staging requires regular directories.');
    const canonical = relative(canonicalRoot, await realpath(path));
    if (isAbsolute(canonical) || canonical.startsWith('..')) throw new Error('Windows AI staging escapes its owned directory.');
    if (path === absoluteRoot) break;
  }
}

/** Validate every child of a tree that will be copied, replaced or removed. */
export async function verifyOwnedTree(root: string, target: string) {
  await verifyOwnedDirectory(root, target);
  const absoluteTarget = resolve(target);
  const absoluteRoot = resolve(root);
  const canonicalRoot = await realpath(absoluteRoot);
  let visited = 0;
  async function visit(path: string) {
    if (++visited > 10000) throw new Error('Windows AI staging tree exceeds its file bound.');
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Windows AI staging refuses reparse links.');
    const canonical = relative(canonicalRoot, await realpath(path));
    if (isAbsolute(canonical) || canonical.startsWith('..')) throw new Error('Windows AI staging escapes its owned directory.');
    if (info.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
    else if (!info.isFile()) throw new Error('Windows AI staging requires regular files.');
  }
  await visit(absoluteTarget);
}

/** Candidate is consumed; upstream publish inputs are copied to it separately. */
export async function replaceStagedDirectory(root: string, candidate: string, destination: string) {
  ownedTarget(root, destination);
  await verifyOwnedTree(root, candidate);
  if (dirname(resolve(destination)) !== resolve(root)) await verifyOwnedDirectory(root, dirname(destination));
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) await verifyOwnedTree(root, destination);
  const backup = `${candidate}-previous`;
  if (exists) await rename(destination, backup);
  try { await rename(candidate, destination); }
  catch (error) { if (exists) await rename(backup, destination); throw error; }
  if (exists) { await verifyOwnedTree(root, backup); await rm(backup, {recursive:true}); }
}

async function run(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, {cwd:workspace, stdin:'ignore', stdout:'inherit', stderr:'inherit', env:{...process.env, DOTNET_NOLOGO:'1', DOTNET_CLI_TELEMETRY_OPTOUT:'1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1', ...env}});
  if (await child.exited !== 0) throw new Error(`Windows AI build failed: ${args[0]}`);
}

async function stage() {
  const requested = process.argv.find(argument => argument.startsWith('--arch='))?.slice(7);
  const arch = requested ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Windows AI staging requires Windows x64 or ARM64.');
  const runtime = `win-${arch}`;
  const buildRoot = join(worker, '.build');
  await verifyOwnedDirectory(workspace, worker);
  await mkdir(buildRoot, {recursive:true});
  await verifyOwnedDirectory(workspace, buildRoot);
  const fresh = await mkdtemp(join(buildRoot, `stable-${runtime}-`));
  const artifacts = join(fresh, 'artifacts');
  const publish = join(fresh, 'publish');
  const project = join(worker, 'Lumen.WindowsAi.csproj');
  await run(['dotnet','restore',project,'-r',runtime,`-p:RuntimeIdentifier=${runtime}`,'--artifacts-path',artifacts,'--configfile',join(worker,'nuget.config'),'--locked-mode']);
  await run(['dotnet','publish',project,'-c','Release','-r',runtime,'--self-contained','true','--no-restore','--artifacts-path',artifacts,'-p:PublishSingleFile=false','-p:PublishTrimmed=false','-p:TreatWarningsAsErrors=true','-o',publish]);
  await verifyOwnedTree(workspace, publish);
  await run(['bun','test',join(worker,'stable-package.test.ts')], {LUMEN_WINDOWS_AI_PACKAGE_ROOT:publish});
  await run(['dotnet','run','--project',join(worker,'Tests','Lumen.WindowsAi.Tests.csproj')]);
  if (arch === process.arch) await run(['bun','test',join(worker,'protocol.test.ts')], {LUMEN_WINDOWS_AI_TEST_EXE:join(publish,'lumen-windows-ai.exe')});
  if (process.argv.includes('--build-only')) { console.log(`Published and verified Windows AI helper (${runtime}) at ${publish}; staging was not requested.`); return; }
  const binaries = join(workspace,'src-tauri','binaries');
  await verifyOwnedDirectory(workspace, join(workspace, 'src-tauri'));
  await mkdir(binaries, {recursive:true});
  await verifyOwnedDirectory(workspace, binaries);
  const candidate = await mkdtemp(join(binaries,'.windows-ai-stable-'));
  await cp(publish,candidate,{recursive:true,errorOnExist:true,force:false});
  await verifyOwnedTree(workspace, join(worker,'licenses'));
  await cp(join(worker,'licenses'),join(candidate,'licenses'),{recursive:true});
  await cp(join(worker,'sdk-lock.json'),join(candidate,'sdk-lock.json'));
  await replaceStagedDirectory(workspace,candidate,join(binaries,'windows-ai'));
  await run(['bun','test',join(worker,'stable-package.test.ts')], {LUMEN_WINDOWS_AI_PACKAGE_ROOT:join(binaries,'windows-ai')});
  console.log(`Staged Windows AI helper (${runtime}) from ${publish}; no model, execution provider, identity package, or certificate was installed.`);
}

if (import.meta.main) await stage();
