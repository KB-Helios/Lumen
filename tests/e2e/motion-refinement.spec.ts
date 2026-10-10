import {expect, test} from '@playwright/test';

test('launcher exit retains content and the input survives reversal with its caret and composition', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.goto('/?service=memory');
  const input = page.getByRole('searchbox', {name: 'Search files'});
  await input.fill('report');
  await expect(page.locator('[data-einui-slot="workspace"]')).toBeVisible();
  const identity = await input.elementHandle();
  await input.fill('');
  await expect(page.locator('[data-einui-slot="footer"]')).toBeAttached();
  await input.fill('report again');
  await input.evaluate((element: HTMLInputElement) => {
    element.setSelectionRange(3, 3);
    element.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
  });
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(3);
  await expect(page.locator('[data-einui-slot="workspace"]')).toBeVisible();
  expect(await identity?.evaluate((element) => element === document.querySelector('input[type="search"]'))).toBe(true);
  await input.dispatchEvent('compositionend');
  await input.fill('');
  await expect(page.locator('[data-einui-slot="workspace"]')).toHaveCount(0);
  await expect(page.locator('[data-einui-slot="footer"]')).toHaveCount(0);
  expect(await identity?.evaluate((element) => element.isConnected)).toBe(true);
});

test('full-motion selection settles on virtual rows after rapid reversal and scroll', async ({page}) => {
  await page.goto('/?gallery=1&scenario=large-results&capture=1&theme=dark');
  const capsule = page.locator('[data-selection-capsule]');
  const viewport = page.getByRole('grid', {name: 'Search results'}).locator('..');
  for (const index of ['00003', '00006', '00002']) {
    await page.getByRole('row', {name: new RegExp(`^Indexed source ${index}\\.tsx`)}).click();
  }
  await viewport.evaluate((element) => {element.scrollTop = 5600;});
  const selected = page.getByRole('row', {name: /^Indexed source 00100\.tsx/});
  await selected.click();
  await expect.poll(async () => {
    const [row, highlight] = await Promise.all([selected.boundingBox(), capsule.boundingBox()]);
    return Math.abs((row?.y ?? 0) - (highlight?.y ?? -100));
  }).toBeLessThanOrEqual(1);
  expect(await page.locator('[data-result-id]').count()).toBeLessThan(40);
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  expect(await capsule.evaluate((element) => getComputedStyle(element).willChange)).toBe('auto');
});

test('preview loading completes one shimmer sweep while the skeleton stays visible', async ({page}) => {
  await page.goto('/?gallery=1&scenario=preview-loading&capture=1&theme=dark');
  const skeleton = page.getByRole('status', {name: 'Loading preview'});
  await expect(skeleton).toBeVisible();
  await expect.poll(() => skeleton.evaluate((element) => element.getAnimations({subtree: true}).filter((animation) => animation.playState === 'running').length)).toBe(0);
  await expect(skeleton).toBeVisible();
});

test('glass changes shared decoration without fading text and opaque materials take precedence', async ({page}, testInfo) => {
  await page.goto('/?service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).focus();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', {name: 'Appearance', exact: true}).click();
  const slider = page.getByRole('slider', {name: 'Glass intensity'});
  const preview = page.getByLabel('Appearance preview');
  await expect(slider).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('appearance.png')});
  await slider.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => preview.locator('[data-material-layer="noise"]').evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  expect(await preview.getByText('Preview', {exact: true}).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await page.keyboard.press('End');
  await expect.poll(() => preview.locator('[data-material-layer="noise"]').evaluate((element) => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.018);
  await page.getByRole('switch', {name: 'Use transparency'}).focus();
  await page.keyboard.press('Space');
  await expect(preview.locator('[data-material-layer="noise"]')).toBeHidden();
  await expect(page.getByRole('switch', {name: 'Synchronize reduced motion'})).toHaveCount(0);
});

test('reduced-motion controls and overlays contain no cosmetic spatial keyframes', async ({page}) => {
  await page.goto('/?gallery=1&scenario=settings-general&capture=1&theme=reduced-motion');
  const close = page.getByRole('button', {name: 'Close settings'});
  await close.evaluate((element) => element.setAttribute('data-pressed', 'true'));
  expect(await close.evaluate((element) => ({scale: getComputedStyle(element).scale, translate: getComputedStyle(element).translate}))).toEqual({scale: 'none', translate: 'none'});
  const keyframes = await page.evaluate(() => {
    const root = document.querySelector('[data-reduced-motion="true"]')!;
    const overlay = document.createElement('div');
    overlay.className = 'lumen-preview-modal';
    overlay.setAttribute('data-entering', 'true');
    root.append(overlay);
    const frames = overlay.getAnimations().flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes());
    overlay.remove();
    return frames;
  });
  expect(keyframes.length).toBeGreaterThan(0);
  expect(keyframes.every((frame) => !frame.transform || frame.transform === 'none')).toBe(true);
});
