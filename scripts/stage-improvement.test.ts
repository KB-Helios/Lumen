import {expect, test} from 'vitest';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

test('reproducible Docker export uses an owned tar and explicitly loads it before inspection', async () => {
  const source = await readFile(join(import.meta.dirname, 'stage-improvement.ts'), 'utf8');
  expect(source).toContain("const exported = join(temporary, 'exported-image.tar')");
  expect(source).toContain('`type=docker,dest=${exported},rewrite-timestamp=true`');
  const load = source.indexOf("'image', 'load', '--input', exported");
  expect(load).toBeGreaterThan(source.indexOf('`type=docker,dest=${exported},rewrite-timestamp=true`'));
  expect(load).toBeLessThan(source.indexOf("'image', 'inspect', image"));
  expect(source).toContain('`SOURCE_DATE_EPOCH=${sourceDateEpoch}`');
  expect(source).toContain("join(temporary, 'canonical.tar')");
});
