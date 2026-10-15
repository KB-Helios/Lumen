/** Build-time release trust; no runtime manifest or environment digest is accepted. */
import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {AGENTGATEWAY_UPSTREAM_SHA256} from './stage-sidecars';

type Identity = {subject:string; thumbprint:string};
type Signature = Identity & {status:string; sha256:boolean; timestamped:boolean; signers?:Identity[]; packageName?:string; packageVersion?:string; packagePublisher?:string};
type Inventory = Record<string, {sha256:string; size:number}>;
type Mapping = Record<string,string>;
type Seal = {version:1; productVersion:string; original:Inventory; final:Inventory; signatures:Record<string,Signature>};
const root = resolve(import.meta.dirname, '..');
const work = join(root, '.build/release');
const sealPath = join(work, 'seal.json');
const target = 'x86_64-pc-windows-msvc';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function checkVersions(packageVersion:unknown, tauriVersion:unknown, cargo:string, tag?:string): string {
  const version = cargo.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (typeof packageVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageVersion)
    || packageVersion !== tauriVersion || packageVersion !== version) throw new Error('Release version mismatch (package/Tauri/Cargo), or unsupported nonnumeric Windows release version');
  if (tag !== undefined && tag !== `v${version}`) throw new Error('Release tag must equal the product version');
  return packageVersion;
}

export function isPortableExecutable(bytes:Uint8Array): boolean {
  const data = Buffer.from(bytes);
  if (data.length < 64 || data.toString('ascii',0,2) !== 'MZ') return false;
  const offset = data.readUInt32LE(60);
  return offset >= 64 && offset <= data.length - 4 && data.readUInt32LE(offset) === 0x4550;
}

export function assertSigningMutation(before:Uint8Array,after:Uint8Array) {
  if (hash(before) === hash(after)) return;
  function layout(bytes:Uint8Array) {
    const data = Buffer.from(bytes);
    if (!isPortableExecutable(data)) throw new Error('Invalid signing mutation PE');
    const optional = data.readUInt32LE(60)+24;
    if (optional+152 > data.length) throw new Error('Truncated signing mutation PE');
    const magic = data.readUInt16LE(optional);
    const directory = optional+(magic===523?144:magic===267?128:0);
    if (directory === optional) throw new Error('Unsupported signing mutation PE');
    return {data,checksum:optional+64,directory,offset:data.readUInt32LE(directory),size:data.readUInt32LE(directory+4)};
  }
  const original = layout(before), final = layout(after);
  if (original.offset || original.size) throw new Error('Retained vendor signature bytes must not change');
  const aligned = Math.ceil(before.length/8)*8;
  if (final.offset !== aligned || final.size < 8 || final.offset+final.size !== after.length || final.directory !== original.directory) throw new Error('Unexpected signing mutation outside appended certificate table');
  const unsigned = Buffer.concat([original.data,Buffer.alloc(aligned-before.length)]);
  const signed = Buffer.from(final.data.subarray(0,final.offset));
  for (const data of [unsigned,signed]) {
    data.fill(0,original.checksum,original.checksum+4);
    data.fill(0,original.directory,original.directory+8);
  }
  if (hash(unsigned) !== hash(signed)) throw new Error('Signing mutation changed verified executable content');
}

export function assertSignature(signature:Signature, approved:Identity[]) {
  if (signature.status !== 'Valid' || signature.sha256 !== true || signature.timestamped !== true
    || ![signature,...(signature.signers??[])].every(signer => approved.some(identity => identity.subject === signer.subject && identity.thumbprint === signer.thumbprint))) {
    throw new Error(`Unapproved, invalid, non-SHA256 or untimestamped signature: ${signature.subject}`);
  }
}

export function assertIdentityMetadata(metadata:Pick<Signature,'packageName'|'packageVersion'|'packagePublisher'>, version:string, publisher:string) {
  if (metadata.packageName !== 'Bridgehammer.Lumen' || metadata.packageVersion !== `${version}.0` || metadata.packagePublisher !== publisher) throw new Error('Actual optional Lumen identity package name/publisher/version mismatch');
}

async function regularFile(path:string) {
  const absolute = resolve(path);
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink()) throw new Error('Release refuses reparse links');
    if (ancestor === absolute ? !info.isFile() : !info.isDirectory()) throw new Error('Release requires regular files/directories');
    if (dirname(ancestor) === ancestor) break;
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error('Release path resolves outside its source');
  return readFile(absolute);
}

export async function inventory(mapping:Mapping): Promise<Inventory> {
  const result:Inventory = {};
  const seen = new Set<string>();
  for (const name of Object.keys(mapping).sort()) {
    if (isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || /[. ]$|[<>:"|?*]/.test(part) || [...part].some(character => character.charCodeAt(0)<32))) throw new Error('Unsafe release inventory path');
    if (seen.has(name.toLowerCase())) throw new Error('Release installed path collision');
    seen.add(name.toLowerCase());
    const data = await regularFile(mapping[name]);
    result[name] = {sha256:hash(data), size:data.length};
  }
  return result;
}

export async function assertInventory(mapping:Mapping, expected:Inventory) {
  if (JSON.stringify(await inventory(mapping)) !== JSON.stringify(expected)) throw new Error('Release seal mismatch: missing, extra or changed resource');
}

export async function preparePayload(mapping:Mapping, originals:string, sign:(path:string, name:string) => Promise<void>) {
  const original = await inventory(mapping);
  // Preserve verified staging output before any signature mutation.
  for (const [name,path] of Object.entries(mapping)) {
    const destination = join(originals,name); await mkdir(dirname(destination), {recursive:true});
    await copyFile(path,destination);
  }
  await assertInventory(Object.fromEntries(Object.keys(mapping).map(name => [name,join(originals,name)])), original);
  for (const [name,path] of Object.entries(mapping)) await sign(path,name);
  return {original, final:await inventory(mapping)};
}

async function walk(path:string): Promise<string[]> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Release refuses reparse links');
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error('Release refuses nonregular payload');
  const files:string[] = [];
  for (const child of (await readdir(path)).sort()) files.push(...await walk(join(path,child)));
  if (files.length > 20000) throw new Error('Release payload exceeds file bound');
  return files;
}

async function payload(): Promise<Mapping> {
  const config = JSON.parse(await readFile(join(root,'src-tauri/tauri.conf.json'),'utf8'));
  const mapping:Mapping = {};
  function add(name:string,path:string) {
    if (Object.keys(mapping).some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Release installed path collision');
    mapping[name] = path;
  }
  for (const bin of config.bundle.externalBin as string[]) add(`${basename(bin)}.exe`,join(root,'src-tauri',`${bin}-${target}.exe`));
  for (const [source,destination] of Object.entries(config.bundle.resources) as [string,string][]) {
    const absolute = resolve(root,'src-tauri',source);
    const directory = (await lstat(absolute)).isDirectory();
    for (const path of await walk(absolute)) add(directory ? `${destination.replace(/\/$/,'')}/${relative(absolute,path).replaceAll('\\','/')}` : destination,path);
  }
  return mapping;
}

async function versions() {
  return checkVersions(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,
    JSON.parse(await readFile(join(root,'src-tauri/tauri.conf.json'),'utf8')).version,
    await readFile(join(root,'src-tauri/Cargo.toml'),'utf8'), process.env.RELEASE_TAG);
}

function owner(): Identity {
  const thumbprint = process.env.LUMEN_SIGN_CERT_SHA1 ?? '';
  const subject = process.env.LUMEN_SIGN_CERT_SUBJECT ?? '';
  if (!/^[A-F0-9]{40}$/.test(thumbprint) || !subject.startsWith('CN=')) throw new Error('Existing owner certificate locator and exact subject are required (LUMEN_SIGN_CERT_SHA1 / LUMEN_SIGN_CERT_SUBJECT)');
  return {thumbprint,subject};
}

function run(args:string[], capture = false, env:Record<string,string|undefined> = {}) {
  const result = Bun.spawnSync(args, {cwd:root, env:{...process.env,...env}, stdin:'ignore', stdout:capture?'pipe':'inherit', stderr:'inherit'});
  if (result.exitCode !== 0) throw new Error(`Release command failed (${result.exitCode}): ${args[0]} ${args.slice(1,3).join(' ')}`);
  return capture ? result.stdout.toString().trim() : '';
}

function signature(action:string,path?:string): Signature {
  const {subject,thumbprint,status,sha256,timestamped,signers,packageName,packageVersion,packagePublisher} = JSON.parse(run(['powershell.exe','-NoProfile','-File',join(root,'scripts/sign-release.ps1'),'-Action',action,...(path?['-Path',path]:[])],true));
  return {subject,thumbprint,status,sha256,timestamped,signers:signers?.map(({subject,thumbprint}:Identity) => ({subject,thumbprint})),packageName,packageVersion,packagePublisher};
}

async function vendors(name:string): Promise<Identity[]> {
  const policy = JSON.parse(await readFile(join(root,'packaging/windows/retained-signers.json'),'utf8')) as {prefix:string; subject:string; thumbprint:string}[];
  return policy.filter(row => name.startsWith(row.prefix)).map(({subject,thumbprint}) => ({subject,thumbprint}));
}

async function verifyFile(path:string,name:string, expected?:Signature) {
  const data = await regularFile(path);
  const pe = isPortableExecutable(data);
  if (/\.(exe|dll|pyd)$/i.test(name) && !pe) throw new Error(`Invalid PE payload: ${name}`);
  if (!pe && extname(name) !== '.msix') return undefined;
  const report = signature('Verify',path);
  assertSignature(report, expected ? [expected,...(expected.signers??[])] : [owner(),...await vendors(name)]);
  return report;
}

async function prepare() {
  const productVersion = await versions(); owner(); signature('Preflight');
  await mkdir(work,{recursive:true});
  if (await lstat(sealPath).catch(() => undefined)) throw new Error('Release seal already exists; use a fresh checkout/build directory for each signed release');
  const mapping = await payload();
  const signatures:Record<string,Signature> = {};
  const originals = await mkdtemp(join(work,'originals-'));
  const result = await preparePayload(mapping,originals, async (path,name) => {
    const data = await regularFile(path);
    if (!isPortableExecutable(data)) {
      if (/\.(exe|dll|pyd)$/i.test(name)) throw new Error(`Invalid PE payload: ${name}`);
      return;
    }
    const existing = signature('Inspect',path);
    if (existing.status === 'NotSigned') signature('Sign',path);
    signatures[name] = (await verifyFile(path,name))!;
  });
  const source = {revision:run(['git','rev-parse','HEAD'],true),dirty:run(['git','status','--porcelain','--untracked-files=no'],true)};
  await writeFile(join(work,'provenance.json'),JSON.stringify({version:1,productVersion,source,originals:relative(root,originals),files:result.original},null,2));
  await writeFile(sealPath,JSON.stringify({version:1,productVersion,...result,signatures} satisfies Seal,null,2));
  await verifyStaged();
}

async function verifyStaged() {
  const bytes = await regularFile(sealPath);
  const seal = JSON.parse(bytes.toString()) as Seal;
  if (seal.version !== 1 || seal.productVersion !== await versions()) throw new Error('Stale release seal version');
  const mapping = await payload();
  await assertInventory(mapping,seal.final);
  const provenance = JSON.parse((await regularFile(join(work,'provenance.json'))).toString()) as {version:number; productVersion:string; originals:string; files:Inventory};
  const originalRoot = resolve(root,provenance.originals);
  if (!originalRoot.startsWith(`${work}${process.platform === 'win32'?'\\':'/'}`) || provenance.version !== 1 || provenance.productVersion !== seal.productVersion || JSON.stringify(provenance.files) !== JSON.stringify(seal.original)) throw new Error('Release upstream provenance mismatch');
  await assertInventory(Object.fromEntries(Object.keys(seal.original).map(name => [name,join(originalRoot,name)])),seal.original);
  if (seal.original['agentgateway.exe']?.sha256 !== AGENTGATEWAY_UPSTREAM_SHA256) throw new Error('Original Gateway provenance does not match its immutable upstream pin');
  for (const [name,path] of Object.entries(mapping)) {
    if (seal.original[name]?.sha256 === seal.final[name]?.sha256) continue;
    assertSigningMutation(await regularFile(join(originalRoot,name)),await regularFile(path));
  }
  if (JSON.stringify(Object.keys(seal.original)) !== JSON.stringify(Object.keys(seal.final))) throw new Error('Release provenance inventory mismatch');
  for (const [name,path] of Object.entries(mapping)) {
    const report = await verifyFile(path,name);
    if (JSON.stringify(report) !== JSON.stringify(seal.signatures[name])) throw new Error(`Release signature seal mismatch: ${name}`);
  }
  const digest = seal.final['agentgateway.exe']?.sha256;
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Sealed Gateway digest missing');
  return {seal, binding:`lumen-release-v1:${hash(bytes)}:${digest}`};
}

export function assertCompiledBinding(main:Uint8Array, binding:string) {
  if (!Buffer.from(main).includes(Buffer.from(binding))) throw new Error('Signed main lacks current compiled release binding (stale or unsigned build)');
}

export function validateArchivePaths(listing:string): string[] {
  const files:string[] = [];
  const seen = new Set<string>();
  for (const block of listing.replaceAll('\r','').split(/\n\s*\n/)) {
    const name = block.match(/^Path = (.+)$/m)?.[1].replaceAll('\\','/');
    if (!name) continue;
    if (isAbsolute(name) || name.split('/').some(part => !part || /[. ]$|[<>:"|?*]/.test(part) || [...part].some(character => character.charCodeAt(0)<32)) || seen.has(name.toLowerCase())) throw new Error('Unsafe or colliding archive path');
    seen.add(name.toLowerCase());
    if (!/^Folder = \+$/m.test(block)) files.push(name);
  }
  if (!files.length || files.length > 20000) throw new Error('Missing or excessive archive entries');
  return files;
}

async function verifyRelease() {
  owner(); const {seal,binding} = await verifyStaged();
  const output = resolve(process.env.CARGO_TARGET_DIR ?? join(root,'src-tauri/target'),'release');
  const installers = (await readdir(join(output,'bundle/nsis'))).filter(name => name.endsWith('-setup.exe'));
  const filename = `Lumen_${seal.productVersion}_x64-setup.exe`;
  if (installers.length !== 1 || installers[0] !== filename) throw new Error('Expected exactly one version-matching NSIS installer');
  const installer = join(output,'bundle/nsis',filename);
  const installerSignature = signature('Verify',installer);
  assertSignature(installerSignature,[owner()]);
  // Extraction never executes the installer, its uninstaller or the product.
  const extracted = await mkdtemp(join(work,'extracted-'));
  const archiveCommand = ['powershell.exe','-NoProfile','-File',join(root,'scripts/archive-release.ps1')];
  const archiveFiles = validateArchivePaths(run([...archiveCommand,'-Action','List','-Installer',installer],true));
  run([...archiveCommand,'-Action','Extract','-Installer',installer,'-Destination',extracted]);
  const files = await walk(extracted);
  const mapping:Mapping = Object.fromEntries(files.map(path => [relative(extracted,path).replaceAll('\\','/'),path]));
  if (JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify(archiveFiles.sort())) throw new Error('Extracted archive file set mismatch');
  const installed:Mapping = {};
  for (const name of Object.keys(seal.final)) {
    if (!mapping[name]) throw new Error(`Extracted payload missing: ${name}`);
    installed[name] = mapping[name];
  }
  await assertInventory(installed,seal.final);
  const main = mapping['lumen.exe'];
  if (!main || !mapping['uninstall.exe']) throw new Error('Actual extracted main and generated uninstaller are required; extraction omission is not signature evidence');
  assertCompiledBinding(await regularFile(main),binding);
  const plugins = ['NSISdl.dll','StartMenu.dll','System.dll','nsDialogs.dll','nsis_tauri_utils.dll'];
  // Tauri signs five copied plugins; NSIS embeds only the plugins the template uses.
  const pluginSources:Mapping = {};
  for (const name of plugins) {
    const path = join(output,'nsis/x64/Plugins/x86-unicode',name === 'nsis_tauri_utils.dll'?'additional':'',name);
    assertSignature(signature('Verify',path),[owner()]);
    pluginSources[name] = path;
  }
  if (!Object.keys(mapping).some(name => name.startsWith('$PLUGINSDIR/'))) throw new Error('Extracted NSIS plugins are required');
  const signatures:Record<string,Signature> = {};
  for (const [name,path] of Object.entries(mapping)) {
    if (seal.final[name]) {
      const report = await verifyFile(path,name,seal.signatures[name]);
      if (report) signatures[name] = report;
      continue;
    }
    // 7zip may emit a decompiled diagnostic script; it is not an installed file.
    if (name === '[NSIS].nsi' && !isPortableExecutable(await regularFile(path))) continue;
    if (name !== 'lumen.exe' && name !== 'uninstall.exe' && !(name.startsWith('$PLUGINSDIR/') && plugins.includes(basename(name)))) throw new Error(`Unexpected extracted release payload: ${name}`);
    signatures[name] = signature('Verify',path);
    assertSignature(signatures[name],[owner()]);
    if (name.startsWith('$PLUGINSDIR/') && hash(await regularFile(path)) !== hash(await regularFile(pluginSources[basename(name)]))) throw new Error('Extracted NSIS plugin differs from signed build input');
  }
  const optionalIdentity = join(root,'packaging/windows/output/Lumen.Identity.msix');
  const hasIdentity = !!await lstat(optionalIdentity).catch(() => undefined);
  let identity: {sha256:string;signature:Signature}|undefined;
  if (hasIdentity) {
    const report = signature('Verify',optionalIdentity);
    assertSignature(report,[owner()]);
    assertIdentityMetadata(report,seal.productVersion,owner().subject);
    identity = {sha256:hash(await regularFile(optionalIdentity)),signature:report};
  }
  const report = {version:1,productVersion:seal.productVersion,filename,sha256:hash(await regularFile(installer)),binding,
    owner:owner(),installerSignature,files:await inventory(mapping),signatures,pluginInputs:await inventory(pluginSources),optionalIdentity:identity};
  await writeFile(join(work,'verified.json'),JSON.stringify(report,null,2));
  console.log(`Verified signed release ${filename}; ${files.length} actual extracted files. Installation acceptance remains separate.`);
}

async function main() {
  switch (process.argv[2]) {
    case 'version': console.log(await versions()); break;
    case 'preflight': await versions(); owner(); signature('Preflight'); console.log('Release signing preflight passed'); break;
    case 'before-build':
      await versions();
      if (process.env.LUMEN_RELEASE_BUILD === '1') {
        owner(); signature('Preflight');
        if (await lstat(sealPath).catch(() => undefined)) throw new Error('Signed release requires a fresh seal directory before staging');
      }
      run(['bun','run','stage:sidecars']);
      if (process.env.LUMEN_RELEASE_BUILD === '1') await prepare();
      run(['bun','run','build']); break;
    case 'compile-binding':
      if (process.env.LUMEN_RELEASE_BUILD !== '1') throw new Error('Signed compilation requires the explicit release build wrapper');
      console.log((await verifyStaged()).binding); break;
    case 'verify-staged': await verifyStaged(); break;
    case 'verify': await verifyRelease(); break;
    case 'build': {
      await versions(); owner(); signature('Preflight');
      if (process.env.TAURI_SKIP_SIDECAR_SIGNATURE_CHECK) throw new Error('Sidecar signature bypass is forbidden');
      if (await lstat(sealPath).catch(() => undefined)) throw new Error('Signed release requires a fresh seal directory before staging');
      await mkdir(work,{recursive:true});
      const config = join(work,'tauri.release.json');
      await writeFile(config,JSON.stringify({build:{beforeBundleCommand:'bun scripts/release.ts verify-staged'},bundle:{windows:{signCommand:{cmd:'powershell.exe',args:['-NoProfile','-File',join(root,'scripts/sign-release.ps1'),'-Action','Sign','-Path','%1']}}}}));
      run(['bun','run','tauri','build','--config',config],false,{LUMEN_RELEASE_BUILD:'1'});
      await verifyRelease(); break;
    }
    default: throw new Error('Expected release command: version/preflight/before-build/build/verify/verify-staged/compile-binding');
  }
}

if (import.meta.main) await main();
