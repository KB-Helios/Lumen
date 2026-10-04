import {expect, test} from '@playwright/test';

test('persists download permission without starting a model and opens public help in settings', async ({page}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({width: 1000, height: 760});
  await page.goto('/?service=memory');
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', {name: 'Privacy', exact: true}).click();
  const permission = page.getByRole('switch', {name: 'Allow local model downloads', exact: true});
  await expect(permission).not.toBeChecked();
  await permission.focus();
  await page.keyboard.press('Space');
  await expect(permission).toBeChecked();
  await page.getByRole('tab', {name: 'Search', exact: true}).click();
  await page.getByRole('switch', {name: 'Search Lumen app content', exact: true}).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  const search = page.getByRole('searchbox', {name: 'Search files', exact: true});
  await search.fill('privacy');
  await expect(page.getByRole('tab', {name: 'App content', exact: true})).toBeVisible();
  await expect(page.locator('[data-result-id="app-content:lumen.privacy"]')).toBeVisible();
  await page.locator('[data-result-id="app-content:lumen.privacy"]').dblclick();
  await expect(page.getByRole('heading', {name: 'Privacy', exact: true})).toBeVisible();
  await expect(permission).toBeChecked();
  await page.reload();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', {name: 'Privacy', exact: true}).click();
  await expect(permission).toBeChecked();
  await page.getByRole('tab', {name: 'Local AI', exact: true}).click();
  await expect(page.getByText('Open the Windows desktop app to use this capability.').first()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Test selected AI engine'})).toBeDisabled();
});

test('renders ready, unavailable, preparing, and failed integration fixtures', async ({page}) => {
  for (const state of ['ready', 'unavailable', 'preparing', 'failed']) {
    await page.goto(`/?gallery=1&scenario=windows-ai-${state}&capture=1`);
    await expect(page.locator('[data-gallery-scenario]')).toHaveAttribute('data-gallery-scenario', `windows-ai-${state}`);
    await expect(page.getByText('Windows language model', {exact: true})).toBeVisible();
    const text = state === 'ready' ? 'Available on this fixture device.' : state === 'unavailable' ? 'Preview runtime is missing (fixture).' : state === 'preparing' ? 'Preparing model · 42% (fixture)' : 'The preview model could not be prepared (fixture).';
    await expect(page.getByText(text, {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Test selected AI engine'})).toBeDisabled();
  }
});
