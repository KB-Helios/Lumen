import {expect, test} from '@playwright/test';

test('provider Edit restoration reveals the same clipped trigger in the settings scrollport', async ({page}, testInfo) => {
  await page.setViewportSize({width: 520, height: 340});
  await page.goto('/?gallery=1&scenario=providers-populated&capture=1&scale=175&theme=reduced-motion');
  const content = page.getByRole('main', {name: 'Settings content'});
  const trigger = page.getByRole('button', {name: 'Edit simulated-long-profile-name-for-responsive-layout', exact: true});
  const navigation = page.getByRole('navigation', {name: 'Settings'});
  await expect(trigger).toBeEnabled();
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeInViewport();
  const identity = await trigger.elementHandle();
  const geometry = () => trigger.evaluate((element) => {
    const port = element.closest('main')!;
    const rect = element.getBoundingClientRect();
    const portRect = port.getBoundingClientRect();
    return {
      trigger: {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right},
      scrollport: {top: portRect.top, bottom: portRect.bottom, left: portRect.left, right: portRect.right},
      scrollTop: port.scrollTop,
      documentScroll: {x: window.scrollX, y: window.scrollY},
    };
  });
  const beforeOpen = await geometry();
  const navigationBefore = await navigation.boundingBox();
  const navigationScrollBefore = await navigation.locator('..').evaluate((element) => element.scrollTop);
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const afterOpen = await geometry();

  // Supply the missing restoration invariant without changing any layout or dialog code.
  await trigger.evaluate((element) => {
    const port = element.closest('main')!;
    port.scrollTop += element.getBoundingClientRect().top - (port.getBoundingClientRect().bottom + 12);
  });
  const clipped = await geometry();
  expect(clipped.trigger.top).toBeGreaterThan(clipped.scrollport.bottom);
  const finalControl = dialog.locator('button:not([disabled]), input:not([disabled])').last();
  await finalControl.focus();
  await expect(finalControl).toBeFocused();
  await expect(finalControl).toBeInViewport();
  expect(await content.evaluate((element) => element.scrollTop)).toBe(clipped.scrollTop);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const afterClose = await geometry();
  await testInfo.attach('settings-focus-geometry.json', {
    body: JSON.stringify({beforeOpen, afterOpen, clipped, afterClose}, null, 2),
    contentType: 'application/json',
  });
  await expect(trigger).toBeInViewport();
  expect(afterClose.trigger.top).toBeGreaterThanOrEqual(afterClose.scrollport.top);
  expect(afterClose.trigger.bottom).toBeLessThanOrEqual(afterClose.scrollport.bottom);
  expect(afterClose.scrollTop).toBeGreaterThan(clipped.scrollTop);
  expect(afterClose.scrollTop).toBeGreaterThan(0);
  expect(afterClose.documentScroll).toEqual(beforeOpen.documentScroll);
  expect(await navigation.boundingBox()).toEqual(navigationBefore);
  expect(await navigation.locator('..').evaluate((element) => element.scrollTop)).toBe(navigationScrollBefore);
  expect(await identity?.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
  await expect(dialog).toHaveCount(0);
});
