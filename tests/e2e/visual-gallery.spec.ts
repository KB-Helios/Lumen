import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 1120, height: 760});
});

test('renders deterministic launcher and preview states in production geometry', async ({page}) => {
  await page.goto('/?gallery=1&scenario=preview-complete&capture=1');

  await expect(page.getByRole('region', {name: 'Lumen visual state gallery'})).toHaveAttribute('data-gallery-scenario', 'preview-complete');
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  await expect(page.getByRole('region', {name: 'File preview'})).toContainText('Private by default');
  await expect(page.getByRole('searchbox', {name: 'Search files'})).toBeFocused();
});

test('keeps the 10,000-result scenario virtualized', async ({page}) => {
  await page.goto('/?gallery=1&scenario=large-results&capture=1');
  const grid = page.getByRole('grid', {name: 'Search results'});

  await expect(grid).toHaveAttribute('aria-rowcount', '10000');
  expect(await page.locator('[data-result-id]').count()).toBeLessThan(40);
});

for (const theme of ['dark', 'light', 'opaque', 'reduced-effects', 'reduced-motion', 'forced-colors']) {
  test(`simulated provider dialogs retain reachable controls and restore focus across all text scales in ${theme}`, async ({page}) => {
    test.setTimeout(180_000);
    await page.setViewportSize({width: 520, height: 340});
    await page.emulateMedia({forcedColors: theme === 'forced-colors' ? 'active' : 'none'});
    for (const scale of [100, 125, 150, 175, 200]) {
      for (const [scenario, trigger] of [
        ['providers-add', 'Add provider'],
        ['providers-edit', 'Edit simulated-long-profile-name-for-responsive-layout'],
        ['providers-remove', 'Remove simulated-long-profile-name-for-responsive-layout from live'],
      ]) {
        await page.goto(`/?gallery=1&scenario=${scenario}&capture=1&scale=${scale}&theme=${theme}`);
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect.poll(() => dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        for (const control of await dialog.locator('button:not([disabled]), input:not([disabled])').all()) {
          await control.focus();
          await expect(control).toBeFocused();
          await expect(control).toBeInViewport();
          const bounds = await control.boundingBox();
          expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(-1);
          expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(521);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('button', {name: trigger, exact: true})).toBeFocused();
        await expect(page.getByRole('button', {name: trigger, exact: true})).toBeInViewport();
      }
    }
  });
}

test('exposes every appearance axis through stable gallery URLs', async ({page}) => {
  for (const [scenario, attribute, value] of [
    ['theme-light', 'data-resolved-theme', 'light'],
    ['theme-opaque', 'data-transparency', 'disabled'],
    ['theme-high-contrast', 'data-contrast', 'high'],
    ['theme-reduced-motion', 'data-reduced-motion', 'true'],
  ] as const) {
    await page.goto(`/?gallery=1&scenario=${scenario}&capture=1`);
    await expect(page.getByRole('application', {name: 'Lumen'})).toHaveAttribute(attribute, value);
  }
});

test('uses readable semantic foreground and surface colors in the light gallery theme', async ({page}) => {
  await page.goto('/?gallery=1&scenario=theme-light&capture=1');

  const colors = await page.locator('[data-einui-layer="surface"]').evaluate((surface) => {
    const application = surface.closest('[role="application"]');
    if (!(application instanceof HTMLElement)) throw new Error('Missing Lumen application root');
    const applicationStyle = getComputedStyle(application);
    const surfaceStyle = getComputedStyle(surface);
    return {
      foreground: surfaceStyle.color,
      expectedForeground: applicationStyle.getPropertyValue('--lumen-text-primary').trim(),
      background: surfaceStyle.backgroundColor,
      expectedBackground: applicationStyle.getPropertyValue('--lumen-surface-raised').trim(),
    };
  });

  expect(colors.foreground).toBe(colors.expectedForeground);
  expect(colors.background).toBe(colors.expectedBackground);
});

test('renders management and activity surfaces from the same scenario registry', async ({page}) => {
  await page.goto('/?gallery=1&scenario=activity-gaming');
  await expect(page.getByTestId('activity-gaming')).toBeVisible();
  await page.goto('/?gallery=1&scenario=settings-agent-gateway&capture=1');
  await expect(page.getByRole('heading', {name: 'AgentGateway', exact: true})).toBeVisible();
  await page.goto('/?gallery=1&scenario=onboarding-welcome&capture=1');
  await expect(page.getByRole('heading', {name: 'Everything, within reach'})).toBeVisible();
});

test('publishes the constrained launcher state with inner scrolling priorities', async ({page}) => {
  await page.setViewportSize({width: 720, height: 540});
  await page.goto('/?gallery=1&scenario=constrained-work-area&capture=1&scale=200');

  await expect(page.getByRole('region', {name: 'Lumen visual state gallery'})).toHaveAttribute(
    'data-gallery-scenario',
    'constrained-work-area',
  );
  await expect(page.getByRole('searchbox', {name: 'Search files'})).toBeVisible();
  await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  await expect(page.getByRole('region', {name: 'File preview'})).toBeHidden();
  await expect(page.getByTestId('answer-region')).toHaveCount(1);
});
