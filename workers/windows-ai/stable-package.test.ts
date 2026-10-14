import {expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

test('both architecture locks and identity require only the stable runtime', async () => {
  const project = await Bun.file(resolve(import.meta.dir, 'Lumen.WindowsAi.csproj')).text();
  expect(project).toContain('Include="Microsoft.WindowsAppSDK" Version="[2.5.1]"');
  expect(project).not.toContain('AION_ARM64');
  expect(project).not.toContain('AionInstructPreview.Text.Framework');
  for (const arch of ['x64', 'arm64']) {
    const lock = await Bun.file(resolve(import.meta.dir, `packages.win-${arch}.lock.json`)).json();
    expect(lock.dependencies['net10.0-windows10.0.26100']['Microsoft.WindowsAppSDK'].resolved).toBe('2.5.1');
    expect(JSON.stringify(lock)).not.toMatch(/experimental|preview|AionInstructPreview/i);
  }
  const manifest = await Bun.file(resolve(import.meta.dir, '../../packaging/windows/AppxManifest.xml')).text();
  expect(manifest).toContain('Name="Microsoft.WindowsAppRuntime.2"');
  expect(manifest).toContain('MinVersion="2.5.1.0"');
  expect(manifest).not.toContain('experimental');
});

test('fresh published and staged artifacts have no experimental package or speech/Aion DLL', async () => {
  const root = process.env.LUMEN_WINDOWS_AI_PACKAGE_ROOT;
  if (!root) return; // Source-only run; staging always supplies its freshly published path.
  const deps = await Bun.file(resolve(root, 'lumen-windows-ai.deps.json')).json();
  expect(JSON.stringify(deps)).not.toMatch(/experimental|preview|AionInstructPreview/i);
  expect(Object.keys(deps.libraries)).toContain('Microsoft.WindowsAppSDK/2.5.1');
  expect(existsSync(resolve(root, 'Microsoft.Windows.AI.Speech.Projection.dll'))).toBe(false);
  expect(existsSync(resolve(root, 'AionInstructPreview.Text.Projection.dll'))).toBe(false);
});
