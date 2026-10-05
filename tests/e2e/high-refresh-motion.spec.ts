import {expect, test, type Page} from '@playwright/test';

async function expectCapsuleAligned(page: Page) {
  await expect.poll(async () => page.locator('[data-selection-capsule]').evaluate((capsule) => {
    const selected = document.querySelector('[data-result-id][data-selected="true"]');
    if (!selected) return Infinity;
    const actual = capsule.getBoundingClientRect();
    const expected = selected.getBoundingClientRect();
    return Math.max(Math.abs(actual.top - expected.top), Math.abs(actual.height - expected.height));
  })).toBeLessThan(0.5);
}

test('selection uses native transform animation, retargets, and releases it after settling', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.goto('/?service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await search.fill('report');
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  await expectCapsuleAligned(page);

  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-selection-capsule]')
    ?.getAnimations().some((animation) => animation.effect instanceof KeyframeEffect &&
      animation.effect.getKeyframes().some((frame) => typeof frame.transform === 'string')));
  const animatedProperties = await page.locator('[data-selection-capsule]').evaluate((capsule) =>
    capsule.getAnimations().flatMap((animation) => animation.effect instanceof KeyframeEffect
      ? animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame)) : []));
  expect(animatedProperties).toContain('transform');
  expect(animatedProperties).not.toContain('top');
  expect(animatedProperties).not.toContain('height');

  await search.evaluate((element) => {
    for (let index = 0; index < 15; index += 1) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: index % 2 === 0 ? 'ArrowUp' : 'ArrowDown', bubbles: true, cancelable: true,
      }));
    }
  });
  await expectCapsuleAligned(page);
  await expect.poll(() => page.locator('[data-selection-capsule]')
    .evaluate((capsule) => capsule.getAnimations().length)).toBe(0);
  await expect(page.locator('[data-result-id][data-selected="true"]')).toHaveCount(1);
});

test('the capsule follows transformed virtual rows and scrolling under reduced motion', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/?service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).fill('large-set');
  await expect(page.getByRole('grid', {name: 'Search results'})).toHaveAttribute('aria-rowcount', '10000');
  await expectCapsuleAligned(page);
  for (let index = 0; index < 6; index += 1) await page.keyboard.press('ArrowDown');
  await expectCapsuleAligned(page);
  await expect(page.locator('[data-selection-capsule]')).toHaveCSS('opacity', '1');
  expect(await page.locator('[data-selection-capsule]').evaluate((capsule) => capsule.getAnimations().length)).toBe(0);
});

test('turning reduced motion on during a spring snaps to the current selection', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.goto('/?service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).fill('report');
  await expectCapsuleAligned(page);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => (document.querySelector('[data-selection-capsule]')?.getAnimations().length ?? 0) > 0);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await expect(page.getByRole('application', {name: 'Lumen'})).toHaveAttribute('data-reduced-motion', 'true');
  await expectCapsuleAligned(page);
  await page.waitForTimeout(100);
  await expectCapsuleAligned(page);
  expect(await page.locator('[data-selection-capsule]').evaluate((capsule) => capsule.getAnimations().length)).toBe(0);

  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.keyboard.press('ArrowUp');
  await expectCapsuleAligned(page);
});
