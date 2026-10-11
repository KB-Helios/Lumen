import {expect, test, type Page, type TestInfo} from '@playwright/test';

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 880, height: 600});
});

test('completes first-run onboarding with the keyboard', async ({page}, testInfo) => {
  await page.goto('/?onboarding=1');
  await expect(page.getByRole('heading', {name: 'Everything, within reach'})).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', {name: 'Choose one place to start'})).toBeVisible();

  await page.getByRole('button', {name: 'Choose folder'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('C:\\Projects\\Lumen Demo')).toBeVisible();
  await page.getByRole('button', {name: 'Continue'}).focus();
  await page.keyboard.press('Enter');

  for (const heading of ['Make search a reflex', 'Choose how answers run']) {
    await expect(page.getByRole('heading', {name: heading})).toBeVisible();
    const action = page.getByRole('button', {name: heading === 'Choose how answers run' ? 'Start using Lumen' : 'Continue'});
    await action.focus();
    await page.keyboard.press('Enter');
  }

  await expect(page.getByRole('searchbox', {name: 'Search files'})).toBeFocused();
  await capture(page, testInfo, 'onboarding-complete');
});

test('visits every settings page without a pointer and restores search focus', async ({page}, testInfo) => {
  await page.goto('/?onboarded=1&service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await expect(search).toBeFocused();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('navigation', {name: 'Settings'})).toBeVisible();

  for (const name of ['General', 'Appearance', 'Indexed roots', 'Search', 'Local AI', 'AgentGateway', 'Providers', 'Computer Use', 'Activity', 'Privacy', 'Diagnostics']) {
    const tab = page.getByRole('tab', {name});
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', {name, exact: true})).toBeVisible();
  }

  await capture(page, testInfo, 'settings-diagnostics');
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
});

test('keeps settings usable in light, opaque, reduced-motion, and 200-percent text states', async ({page}, testInfo) => {
  await page.goto('/?onboarded=1&service=memory');
  await page.evaluate(() => {
    localStorage.setItem('appearance', JSON.stringify({
      mode: 'light',
      transparency: 'disabled',
      density: 'comfortable',
      preview: 'automatic',
      motion: 'reduced',
      effects: 'reduced',
    }));
  });
  await page.reload();
  await page.keyboard.press('Control+,');
  const application = page.getByRole('application', {name: 'Lumen'});
  await expect(application).toHaveAttribute('data-resolved-theme', 'light');
  await expect(application).toHaveAttribute('data-transparency', 'disabled');
  await expect(application).toHaveAttribute('data-reduced-motion', 'true');
  const opaqueSurface = await page.getByLabel('Lumen settings').evaluate((element) => getComputedStyle(element).backgroundColor);
  const firstChannel = Number(opaqueSurface.match(/[\d.]+/)?.[0] ?? 0);
  expect(firstChannel).toBeGreaterThan(220);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });
  await page.getByRole('tab', {name: 'AgentGateway'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', {name: 'AgentGateway', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Restart AgentGateway'})).toBeVisible();
  expect(await page.getByRole('heading', {name: 'AgentGateway', exact: true}).evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await capture(page, testInfo, 'settings-light-opaque-text-200');
});
