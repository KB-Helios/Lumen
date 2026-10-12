import {expect, test, type Page, type TestInfo} from '@playwright/test';

const appearanceKey = 'appearance';

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 800, height: 540});
});

test('completes search, selection, details, folder, and open without a pointer', async ({page}, testInfo) => {
  await page.goto('/?service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});

  await search.fill('report');
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('row', {name: /Quarterly report/i})).toHaveAttribute(
    'data-selected',
    'true',
  );

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('row', {name: /report-summary/i})).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(page.getByLabel('File preview')).not.toBeAttached();

  await page.keyboard.press('Alt+Enter');
  await expect(page.getByRole('dialog', {name: 'File details'})).toBeVisible();
  await expect(page.getByRole('dialog', {name: 'File details'})).toContainText('Release summary');
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();

  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('search-announcement')).toContainText(
    'Opened the folder containing report-summary.md',
  );

  await capture(page, testInfo, 'expanded-results');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-launcher-visible="false"]')).toBeAttached();
});

test('preserves the full result list and opens details as a dialog at narrow width', async ({page}, testInfo) => {
  await page.setViewportSize({width: 720, height: 540});
  await page.goto('/?service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).fill('report');

  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByLabel('File preview')).toBeHidden();
  await page.keyboard.press('Alt+Enter');
  await expect(page.getByRole('dialog', {name: 'File details'})).toBeVisible();
  await capture(page, testInfo, 'narrow-details');
});

test('keeps local results available when the browser answer route fails', async ({page}) => {
  await page.goto('/?service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await search.fill('report');
  await expect(page.getByRole('row')).toHaveCount(3);

  await search.press('Enter');
  await expect(page.getByTestId('answer-region')).toContainText(
    'The answer runtime is not ready. Local search is still available.',
  );
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('row', {name: /Quarterly report/i})).toHaveAttribute(
    'data-selected',
    'true',
  );
});

test('keeps a stable answer region alongside local results after explicit submission', async ({page}) => {
  await page.goto('/?onboarded=1&service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await search.fill('report');
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();

  await search.press('Enter');
  await expect(page.getByTestId('answer-region')).toHaveCount(1);
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
});

test('handles Unicode and very long filenames without horizontal overflow', async ({page}) => {
  await page.goto('/?service=memory');
  const query = `årsrapport-${'väldigt-lång-'.repeat(12)}終`;
  await page.getByRole('searchbox', {name: 'Search files'}).fill(query);

  await expect(page.getByRole('row', {name: /årsrapport.*終/i})).toBeVisible();
  const overflow = await page.locator('[data-einui-layer="surface"]').evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('keeps 10,000 results virtualized and selection responsive', async ({page}) => {
  await page.goto('/?service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).fill('large-set');

  const grid = page.getByRole('grid', {name: 'Search results'});
  await expect(grid).toHaveAttribute('aria-rowcount', '10000');
  await expect(page.locator('[data-result-id]').first()).toBeVisible();
  expect(await page.locator('[data-result-id]').count()).toBeLessThan(40);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-result-id][data-selected="true"]')).toHaveCount(1);
});

test('a rapid 10,000-result selection burst mounts its latest target and preserves query focus', async ({page}) => {
  await page.goto('/?service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await search.fill('large-set');
  await expect(page.getByRole('grid', {name: 'Search results'})).toHaveAttribute('aria-rowcount', '10000');
  await expect(page.locator('[data-result-id]').first()).toBeVisible();
  const duration = await search.evaluate((element) => {
    const started = performance.now();
    for (let index = 0; index < 30; index += 1) element.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true}));
    return performance.now() - started;
  });
  expect(duration).toBeLessThan(16);
  const selected = page.locator('[data-result-id][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeInViewport();
  await expect(selected).toHaveAttribute('data-result-id', 'large-30');
  await expect(search).toBeFocused();
  expect(await page.locator('[data-result-id]').count()).toBeLessThan(40);
  const capsule = page.locator('[data-selection-capsule]');
  await expect.poll(async () => {
    const [row, highlight] = await Promise.all([selected.boundingBox(), capsule.boundingBox()]);
    return Math.abs((row?.y ?? Infinity) - (highlight?.y ?? 0));
  }).toBeLessThanOrEqual(1);
});

test('renders light, dark, opaque, high-contrast, and reduced-motion states', async ({page}, testInfo) => {
  await page.goto('/?service=memory');
  const application = page.getByRole('application', {name: 'Lumen'});

  for (const [name, appearance] of [
    ['light', {mode: 'light', transparency: 'native', density: 'comfortable', preview: 'automatic', motion: 'full', effects: 'full'}],
    ['dark', {mode: 'dark', transparency: 'native', density: 'comfortable', preview: 'automatic', motion: 'full', effects: 'full'}],
    ['opaque', {mode: 'dark', transparency: 'disabled', density: 'comfortable', preview: 'automatic', motion: 'reduced', effects: 'reduced'}],
  ] as const) {
    await page.evaluate(
      ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
      [appearanceKey, appearance] as const,
    );
    await page.reload();
    await expect(application).toHaveAttribute('data-resolved-theme', appearance.mode);
    await expect(application).toHaveAttribute('data-transparency', appearance.transparency);
    await capture(page, testInfo, `appearance-${name}`);
  }

  await page.emulateMedia({forcedColors: 'active'});
  await page.reload();
  await expect(application).toHaveAttribute('data-contrast', 'high');

  await page.emulateMedia({forcedColors: 'none', reducedMotion: 'reduce'});
  await page.evaluate((key) => localStorage.removeItem(key), appearanceKey);
  await page.reload();
  await expect(application).toHaveAttribute('data-reduced-motion', 'true');
});
