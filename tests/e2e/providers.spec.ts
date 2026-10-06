import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width: 880, height: 600});
});

test('open providers settings via keyboard', async ({page}) => {
  await page.goto('/?onboarded=1&service=memory');
  const search = page.getByRole('searchbox', {name: 'Search files'});
  await expect(search).toBeFocused();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('navigation', {name: 'Settings'})).toBeVisible();

  const tab = page.getByRole('tab', {name: 'Providers'});
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', {name: 'Providers', exact: true})).toBeVisible();
  await expect(page.getByTestId('provider-list')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Authorization center'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Usage'})).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
});
