import {expect, test} from '@playwright/test';

test('renders dark, light, and opaque shell variants', async ({page}) => {
  await page.goto('/?mode=foundation');

  const application = page.getByRole('application', {name: 'Lumen'});
  const launcher = page.getByLabel('Lumen launcher');

  await expect(application).toHaveAttribute('data-theme', 'dark');
  await expect(application).toHaveAttribute('data-transparency', 'native');
  await expect(launcher).toHaveAttribute('data-material', 'mica');
  await expect(page.getByText('Search apps, files, and settings')).toBeVisible();

  await page.keyboard.press('Control+Shift+L');
  await expect(application).toHaveAttribute('data-theme', 'light');

  await page.keyboard.press('Control+Shift+L');
  await expect(application).toHaveAttribute('data-theme', 'dark');
  await expect(application).toHaveAttribute('data-transparency', 'disabled');

  await page.goto('/?service=memory');
  const commandPalette = page.getByLabel('Lumen launcher');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await expect(search).toHaveAttribute('placeholder', 'Search apps and files');
  await page.getByRole('button', {name: 'Switch to Computer Use'}).click();
  await expect(page.getByRole('searchbox', {name: 'Describe a computer task'}))
    .toHaveAttribute('placeholder', 'Describe browser task');
  await page.getByRole('button', {name: 'Switch to file search'}).click();
  await expect(commandPalette).toHaveAttribute('data-upstream', 'einui-glass-command-palette');
  await expect(commandPalette).toHaveAttribute('data-expanded', 'false');
  await search.fill('release');
  await expect(commandPalette).toHaveAttribute('data-expanded', 'true');
  await expect(commandPalette.locator('[data-einui-slot="workspace"]')).toBeVisible();
});

test('keeps the transparent host bounded while the inner surface expands', async ({page}) => {
  await page.goto('/?onboarded=1&service=memory');
  const launcher = page.getByLabel('Lumen launcher');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  const host = page.getByRole('main');
  const before = await search.boundingBox();
  const hostBefore = await host.boundingBox();

  await search.fill('report');
  await expect(launcher).toHaveAttribute('data-expanded', 'true');
  await expect(page.getByRole('region', {name: 'Search workspace'})).toBeVisible();
  const after = await search.boundingBox();
  const hostAfter = await host.boundingBox();

  expect((after?.x ?? 0) - (hostAfter?.x ?? 0)).toBeCloseTo(
    (before?.x ?? 0) - (hostBefore?.x ?? 0),
    0,
  );
  expect((after?.y ?? 0) - (hostAfter?.y ?? 0)).toBeCloseTo(
    (before?.y ?? 0) - (hostBefore?.y ?? 0),
    0,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('browser preview emulates the native launcher bounds', async ({page}) => {
  await page.setViewportSize({width: 1000, height: 700});
  await page.goto('/?onboarded=1&service=memory');

  const host = page.getByRole('main');
  await expect(host).toHaveAttribute('data-browser-window-mode', 'collapsed');
  await expect(host).toHaveCSS('width', '700px');
  await expect(host).toHaveCSS('height', '66px');

  await page.getByRole('searchbox', {name: 'Search files'}).fill('report');
  await expect(host).toHaveAttribute('data-browser-window-mode', 'expanded');
  await expect(host).toHaveCSS('width', '800px');
  await expect(host).toHaveCSS('height', '540px');
  const expandedOverflow = await host.evaluate((element) => {
    const surface = element.querySelector<HTMLElement>('[data-einui-layer="surface"]');
    if (!surface) throw new Error('Launcher surface is missing');
    const hostBounds = element.getBoundingClientRect();
    const surfaceBounds = surface.getBoundingClientRect();
    return {
      bottom: surfaceBounds.bottom - hostBounds.bottom,
      left: hostBounds.left - surfaceBounds.left,
      right: surfaceBounds.right - hostBounds.right,
      top: hostBounds.top - surfaceBounds.top,
    };
  });
  expect(Math.max(...Object.values(expandedOverflow))).toBeLessThanOrEqual(0);
});

