import {expect, test} from '@playwright/test';

test('primary buttons preserve readable accent foregrounds and authored type in both themes', async ({page}) => {
  for (const theme of ['light', 'dark']) {
    await page.goto(`/?gallery=1&scenario=onboarding-welcome&capture=1&theme=${theme}`);
    const primary = page.getByRole('button', {name: 'Begin'});
    await expect(primary).toBeVisible();
    const styles = await primary.evaluate((element) => {
      const css = getComputedStyle(element);
      const parseColor = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (color: number[]) => color
        .map((value) => value / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const reference = document.createElement('span');
      reference.style.color = 'var(--lumen-text-inverse)';
      element.append(reference);
      const expectedForeground = getComputedStyle(reference).color;
      reference.remove();
      const foreground = parseColor(css.color);
      const background = parseColor(css.backgroundColor);
      const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return {foreground: css.color, expectedForeground, fontSize: css.fontSize, contrast: (light + 0.05) / (dark + 0.05)};
    });
    expect(styles.foreground, theme).toBe(styles.expectedForeground);
    expect(styles.fontSize, theme).toBe('14px');
    expect(styles.contrast, theme).toBeGreaterThanOrEqual(4.5);
  }
});

test('the selection highlight follows transformed virtual rows and scrolling', async ({page}) => {
  await page.goto('/?gallery=1&scenario=large-results&capture=1&theme=reduced-motion');
  const capsule = page.locator('[data-selection-capsule]');
  const results = page.getByRole('grid', {name: 'Search results'}).locator('..');
  const expectHighlightOn = async (row: import('@playwright/test').Locator) => {
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(capsule).toHaveCSS('opacity', '1');
    await expect.poll(async () => {
      const [rowBox, capsuleBox] = await Promise.all([row.boundingBox(), capsule.boundingBox()]);
      return Math.abs((rowBox?.y ?? 0) - (capsuleBox?.y ?? 0));
    }).toBeLessThanOrEqual(1);
  };
  await expectHighlightOn(page.getByRole('row', {name: /^Indexed source 00002\.tsx/}));
  await results.evaluate((element) => { element.scrollTop = 5600; });
  await expectHighlightOn(page.getByRole('row', {name: /^Indexed source 00100\.tsx/}));
  await results.evaluate((element) => { element.scrollTop = 0; });
  await expect(capsule).toHaveCSS('opacity', '0');
  await results.evaluate((element) => { element.scrollTop = 5600; });
  await expect(capsule).toHaveCSS('opacity', '1');
});

test('high-contrast selection keeps file glyphs and labels on the system highlight foreground', async ({page}) => {
  await page.goto('/?gallery=1&scenario=theme-high-contrast&capture=1');
  const selected = page.locator('[data-result-id][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const expectHighlightForeground = async (row: import('@playwright/test').Locator) => {
    await expect.poll(() => row.evaluate((element) => {
      const reference = document.createElement('span');
      reference.style.cssText = 'position:absolute;visibility:hidden;color:HighlightText';
      element.append(reference);
      const foreground = getComputedStyle(reference).color;
      reference.remove();
      const glyph = element.querySelector('[data-testid="file-glyph"]');
      const label = element.querySelector('span.font-medium');
      return glyph && label ? [glyph, label].every((part) => getComputedStyle(part).color === foreground) : false;
    })).toBe(true);
  };
  await expectHighlightForeground(selected);
  const unselected = page.getByRole('row', {name: /report-summary\.md/});
  await unselected.hover();
  await expectHighlightForeground(unselected);
});

test('the selected result has a positioned highlight when the collection first mounts', async ({page}) => {
  await page.setViewportSize({width: 960, height: 640});
  await page.goto('/?gallery=1&scenario=preview-complete&capture=1&theme=reduced-motion');

  const capsule = page.locator('[data-selection-capsule]');
  const selected = page.getByRole('row', {name: /report-summary\.md/});
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(capsule).toHaveCSS('opacity', '1');
  await expect.poll(async () => {
    const [rowBox, capsuleBox] = await Promise.all([selected.boundingBox(), capsule.boundingBox()]);
    return Math.abs((rowBox?.y ?? 0) - (capsuleBox?.y ?? 0));
  }).toBeLessThanOrEqual(1);

  const next = page.getByRole('row', {name: /Quarterly report\.pdf/});
  await next.click();
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => {
    const [rowBox, capsuleBox] = await Promise.all([next.boundingBox(), capsule.boundingBox()]);
    return Math.abs((rowBox?.y ?? 0) - (capsuleBox?.y ?? 0));
  }).toBeLessThanOrEqual(1);
});

test('a short launcher retains a usable results viewport beside a streaming answer', async ({page}) => {
  await page.setViewportSize({width: 960, height: 640});
  await page.goto('/?gallery=1&scenario=constrained-work-area&capture=1');

  const results = page.getByRole('grid', {name: 'Search results'}).locator('..');
  await expect(page.getByTestId('answer-region')).toBeVisible();
  await expect.poll(() => results.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(58);
  await expect(page.getByRole('region', {name: 'File preview'})).toBeHidden();
  await expect(page.getByRole('button', {name: 'Stop answer'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Open selected result'})).toBeVisible();
  for (const mode of ['Auto', 'Local', 'Cloud']) {
    const target = page.getByRole('radio', {name: mode, exact: true}).locator('..');
    await expect.poll(() => target.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(32);
  }

  const row = page.getByRole('row', {name: /Quarterly report\.pdf/});
  const [viewportBox, rowBox] = await Promise.all([results.boundingBox(), row.boundingBox()]);
  expect(viewportBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(
    (viewportBox?.y ?? 0) + (viewportBox?.height ?? 0) + 1,
  );
});

test('automatic preview follows the actual launcher width and yields in short layouts', async ({page}) => {
  await page.setViewportSize({width: 880, height: 640});
  await page.goto('/?gallery=1&scenario=preview-complete&capture=1');
  await expect(page.getByRole('region', {name: 'File preview'})).toBeVisible();
  await expect(page.getByTestId('preview-markdown')).toBeVisible();

  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/?gallery=1&scenario=constrained-work-area&capture=1');
  await expect(page.getByRole('region', {name: 'File preview'})).toBeHidden();
  await expect.poll(() => page.getByRole('grid', {name: 'Search results'}).locator('..')
    .evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(58);
});

test('large text keeps both primary content regions scrollable and action controls contained', async ({page}) => {
  await page.setViewportSize({width: 720, height: 540});
  await page.goto('/?gallery=1&scenario=constrained-work-area&capture=1&scale=200');

  const results = page.getByRole('grid', {name: 'Search results'}).locator('..');
  const answer = page.getByTestId('answer-region');
  await expect.poll(() => results.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(58);
  await expect.poll(() => answer.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(24);
  await page.getByRole('button', {name: 'Stop answer'}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', {name: 'Stop answer'})).toBeInViewport();
  await expect(page.getByRole('button', {name: 'Show file details'})).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});
