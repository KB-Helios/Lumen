import {expect, test} from '@playwright/test';

import {measureHoverSample, sampleHover} from '../../scripts/lib/hover-sample.mjs';

for (const behavior of ['ready', 'missing-state', 'late-state', 'missing-style', 'late-style']) {
  test(`hover sampler detects ${behavior} at the next callback`, async ({page}) => {
    await page.setContent(`<style>
      #row { --einui-command-row-hover: rgb(25, 25, 25); background-color: transparent;
        transition: ${behavior === 'late-style' ? 'background-color 10s' : 'none'}; }
      ${behavior === 'missing-style' ? '' : '#row[data-hovered] { background-color: var(--einui-command-row-hover); }'}
      </style><div id="row">Hover fixture</div>`);
    const row = page.locator('#row');
    await row.evaluate((element, mode) => {
      element.addEventListener('pointerout', () => element.removeAttribute('data-hovered'));
      element.addEventListener('pointerover', () => {
        if (mode === 'missing-state') return;
        if (mode === 'late-state') {
          requestAnimationFrame(() => requestAnimationFrame(() => element.setAttribute('data-hovered', '')));
        } else {
          queueMicrotask(() => element.setAttribute('data-hovered', ''));
        }
      });
    }, behavior);
    const sample = await row.evaluate(measureHoverSample);
    expect(sample.responseMs).toBeLessThanOrEqual(sample.callbackIntervalMs);
    expect(sample.ready, JSON.stringify(sample)).toBe(behavior === 'ready');
    if (behavior === 'ready') {
      const repeated = await sampleHover(row);
      expect(repeated.ready, JSON.stringify(repeated)).toBe(true);
      expect(repeated.resetHovered).toBe(false);
      expect(repeated.background).toBe('rgb(25, 25, 25)');
    }
  });
}

test('reduced-motion ResultRow reaches its hover token on every fresh transition', async ({page}) => {
  await page.goto('/?gallery=1&scenario=expanded-results&capture=1&theme=reduced-motion');
  const row = page.getByRole('row').first();
  await expect(row).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    const sample = await sampleHover(row);
    expect(sample.ready, JSON.stringify(sample)).toBe(true);
  }
});

test('real pointer reduced-motion feedback is ready in the first post-render task', async ({page}) => {
  await page.goto('/?gallery=1&scenario=expanded-results&capture=1&theme=reduced-motion');
  const row = page.getByRole('row').first();
  await expect(row).toBeVisible();
  await row.evaluate((element) => {
    const target = element as HTMLElement & {hoverObservation?: Promise<{hovered: boolean; background: string; expected: string}>};
    target.hoverObservation = new Promise((resolve) => {
      element.addEventListener('pointerover', () => {
        requestAnimationFrame(() => {
          // A posted task observes the completed rendering update, without a
          // timer delay. This is computed-style evidence, not compositor paint.
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            const swatch = document.createElement('span');
            swatch.style.backgroundColor = getComputedStyle(element).getPropertyValue('--einui-command-row-hover');
            element.append(swatch);
            const expected = getComputedStyle(swatch).backgroundColor;
            swatch.remove();
            resolve({hovered: element.hasAttribute('data-hovered'), background: getComputedStyle(element).backgroundColor, expected});
          };
          channel.port2.postMessage(null);
        });
      }, {once: true});
    });
  });
  await row.hover();
  const observed = await row.evaluate((element) => (
    element as HTMLElement & {hoverObservation: Promise<{hovered: boolean; background: string; expected: string}>}
  ).hoverObservation);
  expect(observed.hovered).toBe(true);
  expect(observed.background).toBe(observed.expected);
  expect(observed.background).not.toBe('rgba(0, 0, 0, 0)');
});

test('system reduced motion disables row transitions while normal motion retains them', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/?onboarded=1&service=memory');
  await page.getByRole('searchbox', {name: 'Search files'}).fill('report');
  const row = page.getByRole('row').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveCSS('transition-property', 'none');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await expect(row).toHaveCSS('transition-property', 'background-color, color, transform');
});
