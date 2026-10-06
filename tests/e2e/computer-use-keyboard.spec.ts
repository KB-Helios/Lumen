import {expect, test, type Locator, type Page} from '@playwright/test';

async function expectFocused(locator: Locator) {
  await expect(locator).toBeFocused();
}

async function tab(page: Page, direction: 'forward' | 'backward' = 'forward') {
  await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab');
}

test('keeps every Computer Use safety action in native keyboard order', async ({page}) => {
  await page.setViewportSize({width: 800, height: 540});
  await page.goto('/?onboarded=1&service=memory&computerUse=memory');
  const intentSwitch = page.getByRole('button', {name: 'Switch to Computer Use'});
  await intentSwitch.focus();
  await expectFocused(intentSwitch);
  await page.keyboard.press('Enter');

  const task = page.getByRole('searchbox', {name: 'Describe a computer task'});
  const clear = page.getByRole('button', {name: 'Clear search'});
  await task.fill('Review the support form');
  const run = page.getByRole('button', {name: 'Run in Edge'});
  await expect(run).toBeEnabled();
  await expect(page.getByText('Gemini · Fast · Simulated')).toBeVisible();
  const target = page.getByRole('button', {name: /Computer Use target/});
  const refreshTargets = page.getByRole('button', {name: 'Refresh targets'});
  const visibleBrowser = page.getByRole('checkbox', {name: 'Request visible browser (Fast only)'});

  await task.focus();
  await tab(page);
  await expectFocused(clear);
  await tab(page);
  await expectFocused(target);
  await tab(page);
  await expectFocused(refreshTargets);
  await tab(page);
  await expectFocused(visibleBrowser);
  await tab(page);
  await expectFocused(run);
  await page.keyboard.press('Enter');

  const approve = page.getByRole('button', {name: 'Approve once'});
  const deny = page.getByRole('button', {name: 'Deny and stop'});
  const stop = page.getByRole('button', {name: 'Stop', exact: true});
  const takeOver = page.getByRole('button', {name: 'Take Over'});
  await expect(approve).toBeVisible();
  await task.focus();
  await tab(page);
  await expectFocused(clear);
  await tab(page);
  await expectFocused(approve);
  await tab(page);
  await expectFocused(deny);
  await tab(page);
  await expectFocused(stop);
  await tab(page);
  await expectFocused(takeOver);
  await tab(page, 'backward');
  await expectFocused(stop);
  await tab(page, 'backward');
  await expectFocused(deny);
  await tab(page, 'backward');
  await expectFocused(approve);
  await page.keyboard.press('Enter');

  await expect(approve).toHaveCount(0);
  await task.focus();
  await tab(page);
  await expectFocused(clear);
  await tab(page);
  await expectFocused(stop);
  await tab(page);
  await expectFocused(takeOver);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', {name: 'Stopped', exact: true})).toBeVisible();
  await expect(run).toBeVisible();

  await run.focus();
  await page.keyboard.press('Enter');
  await expect(deny).toBeVisible();
  await task.focus();
  await tab(page);
  await tab(page);
  await tab(page);
  await expectFocused(deny);
  await page.keyboard.press('Enter');
  await expect(run).toBeVisible();
});
