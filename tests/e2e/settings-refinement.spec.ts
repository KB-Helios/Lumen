import {expect, test, type Locator, type Page} from '@playwright/test';
const settingsNames = ['General', 'Appearance', 'Indexed roots', 'Search', 'Local AI', 'AgentGateway', 'Providers', 'Computer Use', 'Activity', 'Privacy', 'Diagnostics'];

async function configurePresentation(page: Page, theme: string) {
  await page.emulateMedia({forcedColors: theme === 'forced-colors' ? 'active' : 'none'});
  await page.addInitScript((presentation) => localStorage.setItem('appearance', JSON.stringify({
    mode: presentation === 'light' ? 'light' : 'dark',
    transparency: presentation === 'opaque' ? 'disabled' : 'native',
    effects: presentation === 'reduced-effects' || presentation === 'opaque' ? 'reduced' : 'full',
    motion: presentation === 'reduced-motion' ? 'reduced' : 'full', density: 'comfortable', preview: 'automatic',
  })), theme);
}

async function assignResizedHost(page: Page, scale: number) {
  // Replace only the DEV browser host's default geometry cap with the assigned viewport.
  // This exercises unchanged production descendants at Rust's actual resized webview bounds.
  await page.locator('[data-browser-window-mode]').evaluate((element) => {
    (element as HTMLElement).style.width = '100%';
    (element as HTMLElement).style.height = '100%';
  });
  await page.evaluate((textScale) => { document.documentElement.style.fontSize = `${16 * textScale / 100}px`; }, scale);
}

async function expectControlsContained(content: Locator, context: string) {
  const outside = await content.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>('button, input:not([type="checkbox"]), [role="switch"], [role="slider"]'))
      // React Aria clips the native range input; its visible target is the thumb.
      .map((control) => control.matches('input[type="range"]') ? control.parentElement?.parentElement ?? control : control)
      .filter((control) => control.getBoundingClientRect().width > 0)
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.left + element.clientWidth + 1;
      })
      .map((control) => ({
        label: control.getAttribute('aria-label') ?? control.getAttribute('aria-labelledby') ?? control.textContent?.trim(),
        tag: control.tagName,
        type: control.getAttribute('type'),
        left: control.getBoundingClientRect().left,
        right: control.getBoundingClientRect().right,
        contentLeft: bounds.left,
        contentRight: bounds.left + element.clientWidth,
      }));
  });
  expect(outside, context).toEqual([]);
}

for (const viewport of [{width: 800, height: 600}, {width: 720, height: 560}, {width: 960, height: 720}, {width: 520, height: 340}]) {
  for (const theme of ['dark', 'light', 'opaque', 'reduced-effects', 'reduced-motion', 'forced-colors']) {
    test(`all onboarding scenes remain reachable at ${viewport.width}x${viewport.height} in ${theme}`, async ({page}) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      await configurePresentation(page, theme);
      for (const scale of [100, 125, 150, 175, 200]) {
        await page.goto('/?onboarding=1');
        await expect(page.getByRole('heading', {name: 'Everything, within reach'})).toBeVisible();
        await assignResizedHost(page, scale);
        for (const [heading, action] of [['Everything, within reach', 'Begin'], ['Choose one place to start', 'Continue'], ['Make search a reflex', 'Continue'], ['Choose how answers run', 'Start using Lumen']]) {
          await expect(page.getByRole('heading', {name: heading})).toBeVisible();
          const scene = page.getByTestId('onboarding-scene').locator('..');
          await expect.poll(() => scene.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
          await expectControlsContained(scene, `${heading} ${theme} ${scale}% ${viewport.width}x${viewport.height}`);
          if (heading === 'Choose one place to start') await page.getByRole('button', {name: 'Choose folder'}).click();
          const button = page.getByRole('button', {name: action, exact: true});
          await button.focus();
          await expect(button).toBeFocused();
          await expect(button).toBeInViewport();
          if (heading !== 'Choose how answers run') await page.keyboard.press('Enter');
        }
      }
    });
  }
}

// Browser layout evidence at Rust's settings default/minimum, plus the requested constrained presentation.
for (const viewport of [{width: 880, height: 600}, {width: 760, height: 520}, {width: 1080, height: 760}, {width: 520, height: 340}]) {
  for (const theme of ['dark', 'light', 'opaque', 'reduced-effects', 'reduced-motion', 'forced-colors']) {
    test(`all settings remain reachable at ${viewport.width}x${viewport.height} in ${theme}`, async ({page}) => {
      test.setTimeout(180_000);
      await page.setViewportSize(viewport);
      await configurePresentation(page, theme);
      for (const scale of [100, 125, 150, 175, 200]) {
        await page.goto('/?onboarded=1&service=memory');
        await expect(page.getByRole('searchbox', {name: 'Search files'})).toBeVisible();
        await page.keyboard.press('Control+,');
        await expect(page.getByRole('main', {name: 'Settings content'})).toBeVisible();
        await assignResizedHost(page, scale);
        if (theme === 'reduced-effects') await expect(page.getByRole('application', {name: 'Lumen'})).toHaveAttribute('data-effects', 'reduced');
        const content = page.getByRole('main', {name: 'Settings content'});
        for (const label of settingsNames) {
          const tab = page.getByRole('tab', {name: label, exact: true});
          await tab.focus();
          await page.keyboard.press('Enter');
          await expect(page.getByRole('heading', {name: label, exact: true})).toBeVisible();
          await expect(tab).toBeFocused();
          await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
          await expectControlsContained(content, `${label} ${theme} ${scale}% ${viewport.width}x${viewport.height}`);
          const action = content.locator('button:not([disabled]), input:not([disabled]):not([type="range"]):not([type="checkbox"]), [role="switch"]:not([disabled]):not([aria-disabled="true"])').last();
          if (await action.count()) {
            await action.focus();
            await expect(action).toBeFocused();
            // React Aria's switch input is deliberately clipped; check the visible label that owns its focus ring.
            const target = await action.getAttribute('role') === 'switch' ? action.locator('xpath=ancestor::label') : action;
            await expect(target).toBeInViewport();
          }
        }
        await expect(page.getByRole('button', {name: 'Close settings'})).toBeInViewport();
      }
    });
  }
}

test('settings navigation wraps enlarged labels without horizontal overflow', async ({page}) => {
  await page.setViewportSize({width: 880, height: 600});
  await page.goto('/?gallery=1&scenario=settings-general&capture=1&scale=200');

  const nav = page.getByRole('navigation', {name: 'Settings'});
  await expect(nav).toBeVisible();
  await expect.poll(() => nav.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const content = page.getByRole('main', {name: 'Settings content'});
  await expect.poll(() => content.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(100);
  await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});

test('settings controls stay within their content viewport at large text sizes', async ({page}) => {
  await page.setViewportSize({width: 720, height: 540});
  await page.goto('/?gallery=1&scenario=settings-general&capture=1&scale=200');

  const content = page.getByRole('main', {name: 'Settings content'});
  for (const name of ['General', 'Appearance', 'Indexed roots', 'Search', 'Local AI', 'AgentGateway', 'Providers', 'Computer Use', 'Activity', 'Privacy', 'Diagnostics']) {
    const tab = page.getByRole('tab', {name, exact: true});
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', {name, exact: true})).toBeVisible();
    await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expectControlsContained(content, `${name} at 200% text in 720x540`);
  }
});

test('settings retain scroll viewports and contained controls across the constrained text-scale matrix', async ({page}) => {
  await page.setViewportSize({width: 520, height: 340});
  for (const scale of [100, 125, 150, 175, 200]) {
    await page.goto(`/?gallery=1&scenario=settings-general&capture=1&scale=${scale}`);
    const content = page.getByRole('main', {name: 'Settings content'});
    const nav = page.getByRole('navigation', {name: 'Settings'});
    await expect.poll(() => content.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(72);
    await expect.poll(() => nav.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    for (const name of ['General', 'Appearance', 'Indexed roots', 'Search', 'Local AI', 'AgentGateway', 'Providers', 'Computer Use', 'Activity', 'Privacy', 'Diagnostics']) {
      await page.getByRole('tab', {name, exact: true}).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('tabpanel', {name, exact: true})).toBeVisible();
      await expect.poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await expectControlsContained(content, `${name} at ${scale}% text in 520x340`);
    }
    await expect(page.getByRole('button', {name: 'Close settings'})).toBeInViewport();
  }
});

test('keyboard page selection resets content scroll and keeps navigation focus', async ({page}) => {
  await page.setViewportSize({width: 880, height: 600});
  await page.goto('/?gallery=1&scenario=settings-general&capture=1&scale=200');

  const content = page.getByRole('main', {name: 'Settings content'});
  await content.evaluate((element) => { element.scrollTop = 240; });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('tab', {name: 'General', exact: true}).focus();
  await page.keyboard.press('ArrowDown');

  await expect(page.getByRole('tab', {name: 'Appearance', exact: true})).toBeFocused();
  await expect(page.getByRole('tabpanel', {name: 'Appearance', exact: true})).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
});

test('onboarding scrolls enlarged scenes while keeping its primary action available', async ({page}) => {
  test.setTimeout(90_000);
  for (const viewport of [{width: 720, height: 560}, {width: 520, height: 340}]) {
    await page.setViewportSize(viewport);
    for (const scale of [100, 125, 150, 175, 200]) {
      await page.goto('/?onboarding=1');
      await expect(page.getByRole('heading', {name: 'Everything, within reach'})).toBeVisible();
      await page.evaluate((textScale) => {
        document.documentElement.style.fontSize = `${16 * textScale / 100}px`;
      }, scale);

      const sceneViewport = page.getByTestId('onboarding-scene').locator('..');
      const scroll = await sceneViewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          clientHeight: element.clientHeight,
          overflowY: getComputedStyle(element).overflowY,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        };
      });
      expect(scroll.clientHeight).toBeGreaterThanOrEqual(72);
      expect(scroll.overflowY).toMatch(/auto|scroll/);
      if (scroll.scrollHeight > scroll.clientHeight) expect(scroll.scrollTop).toBeGreaterThan(0);
      await expect(page.getByRole('button', {name: 'Begin'})).toBeInViewport();
      await page.getByRole('button', {name: 'Begin'}).click();
      await page.getByRole('button', {name: 'Choose folder'}).click();
      await page.getByRole('button', {name: 'Continue'}).click();
      await expect(page.getByRole('heading', {name: 'Make search a reflex'})).toBeVisible();
      await page.getByRole('button', {name: 'Continue'}).click();
      await expect(page.getByRole('heading', {name: 'Choose how answers run'})).toBeAttached();
      await expect.poll(() => sceneViewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await expectControlsContained(sceneViewport, `Onboarding choices at ${scale}% text in ${viewport.width}x${viewport.height}`);
      await expect(page.getByRole('button', {name: 'Start using Lumen'})).toBeInViewport();
    }
  }
});
