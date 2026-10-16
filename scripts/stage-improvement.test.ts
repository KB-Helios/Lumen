import {expect, test, vi} from 'vitest';
import {join} from 'node:path';
import {buildAndLoadImprovementImage} from './stage-improvement';

test('reproducible Docker export uses an owned tar and explicitly loads it before inspection', async () => {
  const context = join('owned fixture with spaces', 'context');
  const exported = join('owned fixture with spaces', 'exported-image.tar');
  const execute = vi.fn<(args: string[], cwd?: string, timeout?: number) => Promise<string>>(async () => 'owned inspection');
  expect(await buildAndLoadImprovementImage(context, exported, execute)).toBe('owned inspection');
  const docker = ['docker', '--host', 'npipe:////./pipe/dockerDesktopLinuxEngine'];
  expect(execute.mock.calls).toEqual([
    [[...docker, 'buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--build-arg', 'SOURCE_DATE_EPOCH=1791353246', '--output', `type=docker,dest=${exported},rewrite-timestamp=true`, '--tag', 'lumen-improvement:prime-0.9.8', context], undefined, 1_800_000],
    [[...docker, 'image', 'load', '--input', exported]],
    [[...docker, 'image', 'inspect', 'lumen-improvement:prime-0.9.8']],
  ]);
});

test('does not inspect an image when the owned export cannot be loaded', async () => {
  const execute = vi.fn(async (args: string[]) => {
    if (args.includes('load')) throw new Error('owned load failed');
    return '';
  });
  await expect(buildAndLoadImprovementImage('owned-context', 'owned.tar', execute)).rejects.toThrow('owned load failed');
  expect(execute.mock.calls).toHaveLength(2);
});
