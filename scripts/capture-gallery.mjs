import {execFileSync} from 'node:child_process';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {chromium} from 'playwright';

import {withLumenDevServer} from './lib/lumen-dev-server.mjs';

const outputDirectory = path.resolve('artifacts/screenshots');
const viewport = {width: 1120, height: 760};

async function captureScreenshot(page, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await page.screenshot(options);
    } catch (error) {
      if (attempt === 4 || error?.code !== 'UNKNOWN') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function waitForScenario(page, scenario) {
  const grid = page.getByRole('grid', {name: 'Search results'});
  if (await grid.count() > 0) {
    const count = Number(await grid.getAttribute('aria-rowcount'));
    if (count > 0) await grid.locator('[data-result-id]').first().waitFor();
  }
  const preview = page.locator('[aria-label="File preview"]');
  if (await preview.count() > 0) {
    if (scenario.id === 'preview-loading') {
      await preview.getByRole('status', {name: 'Loading preview'}).waitFor();
    } else if (scenario.id === 'preview-failed') {
      await preview.getByRole('alert').waitFor();
    } else if (scenario.id === 'permission-required') {
      await preview.getByText('Select a result to preview', {exact: true}).waitFor();
    } else if (Number(await grid.getAttribute('aria-rowcount')) > 0) {
      await preview.locator('[data-testid^="preview-"]').waitFor();
    } else {
      await preview.getByText('Select a result to preview', {exact: true}).waitFor();
    }
  }
  await page.waitForFunction(() => [...document.querySelectorAll(
    '[data-launcher-motion="workspace"], [role="tabpanel"] > div, [aria-label="File preview"] [style*="opacity"]',
  )].every((element) => globalThis.getComputedStyle(element).opacity === '1'));
}

async function createContactSheet(browser, entries) {
  const page = await browser.newPage({viewport: {width: 1680, height: 1000}});
  const cards = await Promise.all(entries.map(async (entry) => {
    const image = await readFile(entry.absolutePath, 'base64');
    return `
      <figure>
        <img src="data:image/png;base64,${image}" alt="${entry.label}">
        <figcaption><strong>${entry.label}</strong><span>${entry.scenario}</span></figcaption>
      </figure>`;
  }));
  await page.setContent(`<!doctype html>
    <html><head><style>
      *{box-sizing:border-box} body{margin:0;padding:28px;background:#111110;color:#fafaf9;font:14px/1.4 "Segoe UI",sans-serif}
      h1{margin:0 0 20px;font-size:26px} main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
      figure{margin:0;padding:10px;background:#1c1c1b;border:1px solid #383836;border-radius:14px;box-shadow:0 12px 30px #0006}
      img{display:block;width:100%;aspect-ratio:28/19;object-fit:cover;border-radius:9px;background:#111110}
      figcaption{display:grid;gap:2px;padding:9px 3px 2px} strong{font-weight:600} span{color:#bfbeba;font-size:12px}
    </style></head><body><h1>Lumen visual state gallery</h1><main>${cards.join('')}</main></body></html>`);
  await captureScreenshot(page, {path: path.join(outputDirectory, 'contact-sheet.png'), fullPage: true});
  await page.close();
}

async function capture(baseUrl) {
  await mkdir(outputDirectory, {recursive: true});
  const browser = await chromium.launch({channel: 'msedge'});
  const context = await browser.newContext({viewport, reducedMotion: 'reduce'});
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/?gallery=1&scenario=collapsed-idle`);
    const scenarioSelect = page.locator('select[aria-label="Gallery scenario"]');
    await scenarioSelect.waitFor();
    const scenarios = await scenarioSelect.locator('option')
      .evaluateAll((options) => options.map((option) => ({
        id: option.value,
        label: option.textContent?.trim() || option.value,
        category: option.dataset.category,
      })));
    if (scenarios.length === 0) {
      throw new Error('The visual state gallery did not expose any scenarios.');
    }
    if (scenarios.some((scenario) => !scenario.category)) {
      throw new Error('Every visual state gallery option must expose its registry category.');
    }
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const entries = [];
    await page.close();
    for (const scenario of scenarios) {
      // Bound renderer/network resources across the complete gallery. Reusing
      // one page for every module-heavy navigation can exhaust Edge resources.
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/?gallery=1&scenario=${encodeURIComponent(scenario.id)}&capture=1`);
        await page.locator(`[data-gallery-scenario="${scenario.id}"]`).waitFor();
        await page.evaluate(async (useLightBackdrop) => {
          document.documentElement.style.background = useLightBackdrop
            ? 'linear-gradient(145deg, #fafaf8, #e2e1dc)'
            : 'radial-gradient(circle at 28% 8%, #30302c, #171716 58%, #111110)';
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, scenario.id === 'theme-light' || scenario.id === 'theme-high-contrast');
        await waitForScenario(page, scenario);
        const filename = `${scenario.id}.png`;
        const absolutePath = path.join(outputDirectory, filename);
        await captureScreenshot(page, {path: absolutePath, animations: 'disabled'});
        entries.push({
          scenario: scenario.id,
          label: scenario.label,
          category: scenario.category,
          file: `artifacts/screenshots/${filename}`,
          absolutePath,
          viewport,
          colorScheme: scenario.id === 'theme-light' ? 'light' : 'dark',
          reducedMotion: true,
          gitSha,
        });
      } finally {
        await page.close();
      }
    }
    await createContactSheet(browser, entries);
    const manifest = {
      generatedAt: new Date().toISOString(),
      gitSha,
      browser: {name: 'Microsoft Edge', version: browser.version()},
      viewport,
      count: entries.length,
      contactSheet: 'artifacts/screenshots/contact-sheet.png',
      captures: entries.map((entry) => ({
        scenario: entry.scenario,
        label: entry.label,
        category: entry.category,
        file: entry.file,
        viewport: entry.viewport,
        colorScheme: entry.colorScheme,
        reducedMotion: entry.reducedMotion,
        gitSha: entry.gitSha,
      })),
    };
    await writeFile(
      path.join(outputDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    process.stdout.write(`Captured ${entries.length} gallery states in ${outputDirectory}.\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

await withLumenDevServer(capture);
