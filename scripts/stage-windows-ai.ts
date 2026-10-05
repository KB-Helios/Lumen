/** Publish a fixed helper. This stages code, never installs an AI model or package. */
import {createHash} from 'node:crypto';
import {cp, mkdir, readdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import pins from '../workers/windows-ai/sdk-lock.json';

const workspace = resolve(import.meta.dir, '..');
const worker = join(workspace, 'workers', 'windows-ai');
const project = join(worker, 'Lumen.WindowsAi.csproj');
const requested = process.argv.find(argument => argument.startsWith('--arch='))?.slice(7);
const arch = requested ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Windows AI staging requires Windows x64 or ARM64.');
const runtime = `win-${arch}`;
const publish = join(worker, '.build', runtime);
const destination = join(workspace, 'src-tauri', 'binaries', 'windows-ai');

async function run(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, {cwd: workspace, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: {...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', ...env}});
  if (await child.exited !== 0) throw new Error(`Windows AI build failed: ${args[0]}`);
}
if (arch === 'arm64') {
  const feed = join(worker, '.nuget');
  await mkdir(feed, {recursive: true});
  const sdk = join(feed, 'AionInstructPreview.Text.Framework.1.0.0.nupkg');
  if (!await Bun.file(sdk).exists()) {
    const response = await fetch(pins.aion.sdkUrl);
    if (!response.ok) throw new Error('The pinned Microsoft Aion SDK release could not be downloaded.');
    const bytes = await response.arrayBuffer();
    if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== pins.aion.sdkSha256) throw new Error('The Aion SDK checksum does not match the pinned official release.');
    await Bun.write(sdk, bytes);
  }
  if (createHash('sha256').update(new Uint8Array(await Bun.file(sdk).arrayBuffer())).digest('hex') !== pins.aion.sdkSha256) throw new Error('The cached Aion SDK checksum does not match the pinned official release.');
}
await run(['dotnet', 'restore', project, '-r', runtime, `-p:RuntimeIdentifier=${runtime}`, '--configfile', join(worker, 'nuget.config'), ...await Bun.file(join(worker, `packages.${runtime}.lock.json`)).exists() ? ['--locked-mode'] : []]);
if (arch === 'arm64') {
  const cachedPackage = join(process.env.NUGET_PACKAGES ?? join(process.env.USERPROFILE!, '.nuget', 'packages'), 'aioninstructpreview.text.framework', '1.0.0', 'aioninstructpreview.text.framework.1.0.0.nupkg');
  if (createHash('sha256').update(new Uint8Array(await Bun.file(cachedPackage).arrayBuffer())).digest('hex') !== pins.aion.sdkSha256) throw new Error('The restored Aion SDK checksum does not match the pinned official release.');
}
await run(['dotnet', 'publish', project, '-c', 'Release', '-r', runtime, '--self-contained', 'true', '--no-restore', '-p:PublishSingleFile=false', '-p:PublishTrimmed=false', '-p:TreatWarningsAsErrors=true', '-o', publish]);
await run(['dotnet', 'run', '--project', join(worker, 'Tests', 'Lumen.WindowsAi.Tests.csproj')]);
if (arch === process.arch) {
  await run(['bun', 'test', join(worker, 'protocol.test.ts')], {LUMEN_WINDOWS_AI_TEST_EXE: join(publish, 'lumen-windows-ai.exe')});
}
if (process.argv.includes('--build-only')) {
  console.log(`Published and verified Windows AI helper (${runtime}); staging was not requested.`);
  process.exit(0);
}
// Keep a verified layout until publication and protocol checks have succeeded.
await mkdir(destination, {recursive: true});
for (const entry of await readdir(destination)) {
  const target = resolve(destination, entry);
  if (!target.startsWith(destination + '\\')) throw new Error('Unsafe Windows AI staging target.');
  await rm(target, {recursive: true, force: true});
}
await cp(publish, destination, {recursive: true});
await cp(join(worker, 'licenses'), join(destination, 'licenses'), {recursive: true});
await cp(join(worker, 'sdk-lock.json'), join(destination, 'sdk-lock.json'));
console.log(`Staged Windows AI helper (${runtime}); no model, execution provider, identity package, or certificate was installed.`);
