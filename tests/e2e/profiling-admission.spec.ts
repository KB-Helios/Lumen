import {expect, test} from '@playwright/test';

import {installReactRendererProbe, readReactRenderers} from '../../scripts/lib/react-renderer-probe.mjs';

test('profiling admission retains every renderer registration', async ({page}) => {
  await installReactRendererProbe(page);
  await page.goto('data:text/html,renderer-probe');
  const ids = await page.evaluate(() => {
    const hook = (window as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {inject(renderer: {bundleType: number; version: string}): number};
    }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    return [hook.inject({bundleType: 1, version: 'development'}), hook.inject({bundleType: 0, version: 'production'})];
  });
  expect(await readReactRenderers(page)).toEqual([
    {bundleType: 1, version: 'development'}, {bundleType: 0, version: 'production'},
  ]);
  expect(ids[0]).not.toBe(ids[1]);
});
