import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, isAbsolute, join, relative, resolve} from 'node:path';

const revision = '2ed835646120f79562407879ff19e8860623775c';
const sourceSha256 = '268cd8c2a925bce531dcd0062aeed5360e4d5b10ec4fdeb6131e2a043d6a44bd';
const sourceDateEpoch = 1791353246;
const runtime = resolve(import.meta.dirname, '..', 'workers', 'improvement-runtime');
const output = resolve(import.meta.dirname, '..', 'src-tauri', 'resources', 'improvement');
const image = 'lumen-improvement:prime-0.9.8';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function run(args: string[], cwd?: string, timeout = 900_000) {
  const process = Bun.spawn(args, {cwd, stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => process.kill(), timeout);
  try {
    // Drain both pipes; staging diagnostics stay outside product UI.
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (code !== 0) throw new Error(`Improvement staging command failed: ${args[0]}\n${stderr.slice(-8000)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

async function normalizeTimes(directory: string) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTimes(path);
    else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('Unexpected build context entry');
    if (!entry.isSymbolicLink()) await utimes(path, sourceDateEpoch, sourceDateEpoch);
  }
  await utimes(directory, sourceDateEpoch, sourceDateEpoch);
}

export async function stageImprovement() {
  const engine = JSON.parse(await run(['docker', '--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'version', '--format', '{{json .Server}}'], undefined, 20_000)) as {Os?: string; Arch?: string};
  if (engine.Os !== 'linux' || engine.Arch !== 'amd64') throw new Error('Start the installed Docker Desktop Linux engine explicitly before staging.');
  const temporary = await mkdtemp(join(tmpdir(), 'lumen-improvement-stage-'));
  try {
    const response = await fetch(`https://codeload.github.com/PrimeIntellect-ai/prime-agent/tar.gz/${revision}`);
    if (!response.ok) throw new Error('Could not download the pinned Prime source');
    const source = new Uint8Array(await response.arrayBuffer());
    if (source.length > 16_777_216 || hash(source) !== sourceSha256) throw new Error('Pinned Prime source checksum mismatch');
    const archive = join(temporary, 'prime-source.tar.gz');
    await writeFile(archive, source);
    const context = join(temporary, 'context');
    await mkdir(join(context, 'prime'), {recursive: true});
    await run(['tar', '-xzf', archive, '--strip-components=1', '-C', join(context, 'prime')]);
    for (const name of ['Dockerfile', 'requirements.lock', 'bridge.py']) await copyFile(join(runtime, name), join(context, name));
    await normalizeTimes(context);
    await run(['docker', '--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--build-arg', `SOURCE_DATE_EPOCH=${sourceDateEpoch}`, '--output', 'type=docker,rewrite-timestamp=true', '--tag', image, context], undefined, 1_800_000);
    const metadata = JSON.parse(await run(['docker', '--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'image', 'inspect', image])) as {Id: string; Os: string; Architecture: string; Config: {Labels: Record<string, string>}}[];
    const installed = metadata[0];
    if (!installed || !/^sha256:[a-f0-9]{64}$/.test(installed.Id) || installed.Os !== 'linux' || installed.Architecture !== 'amd64'
      || installed.Config.Labels['dev.lumen.improvement.revision'] !== revision || installed.Config.Labels['dev.lumen.improvement.protocol'] !== '1') throw new Error('Built image failed identity checks');
    const raw = join(temporary, 'image.tar');
    await run(['docker', '--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'image', 'save', '--output', raw, installed.Id]);
    const canonical = join(temporary, 'canonical.tar');
    const python = process.env.LUMEN_PYTHON ?? 'python';
    await run([python, join(runtime, 'canonical_archive.py'), raw, canonical]);
    if ((await stat(canonical)).size > 2_147_483_648) throw new Error('Improvement image exceeds the archive size limit');
    const archiveSha256 = hash(await readFile(canonical));
    await mkdir(output, {recursive: true});
    await copyFile(canonical, join(output, 'improvement-runtime.tar.staged'));
    await writeFile(join(output, 'improvement-runtime.json.staged'), `${JSON.stringify({protocol: 1, primeVersion: '0.9.8', sourceRevision: revision, imageId: installed.Id, archiveSha256, archive: 'improvement-runtime.tar'}, null, 2)}\n`);
    // Publish the manifest last so partially copied artifacts never pass prepare().
    await rename(join(output, 'improvement-runtime.tar.staged'), join(output, 'improvement-runtime.tar'));
    await rename(join(output, 'improvement-runtime.json.staged'), join(output, 'improvement-runtime.json'));
    console.log(`Staged Prime 0.9.8 image ${installed.Id}; archive SHA-256 ${archiveSha256}`);
  } finally {
    await cleanupStaging(temporary);
  }
}

async function cleanupStaging(temporary: string) {
  const actual = await realpath(temporary);
  const stagingRoot = await realpath(tmpdir());
  const within = relative(stagingRoot, actual);
  if (!within || within.startsWith('..') || isAbsolute(within) || !basename(actual).startsWith('lumen-improvement-stage-')) throw new Error('Refusing to remove an unexpected staging directory');
  await rm(actual, {recursive: true, force: true});
}

if (import.meta.main) await stageImprovement();
