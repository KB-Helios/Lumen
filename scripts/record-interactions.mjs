import {execFileSync} from 'node:child_process';
import {mkdir, readdir, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {chromium} from 'playwright';

import {withLumenDevServer} from './lib/lumen-dev-server.mjs';

const outputDirectory = path.resolve('artifacts/recordings');
const viewport = {width: 1120, height: 760};
const collapsedViewport = {width: 700, height: 66};
const expandedViewport = {width: 900, height: 620};

async function pause(page, milliseconds = 320) {
  await page.waitForTimeout(milliseconds);
}

async function sustainSearchActivity(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const scopeTabs = [...document.querySelectorAll('[role="tab"]')]
      .filter((tab) => tab.textContent === 'All' || tab.textContent === 'Files');
    if (scopeTabs.length !== 2) {
      reject(new Error('Expected the All and Files search scopes.'));
      return;
    }

    let lottieSeen = false;
    let pulse = 0;
    const interval = window.setInterval(() => {
      scopeTabs[pulse % scopeTabs.length].click();
      lottieSeen ||= document.querySelector('[data-lottie-host] svg') !== null;
      pulse += 1;
      if (pulse === 101) {
        window.clearInterval(interval);
        if (lottieSeen) resolve();
        else reject(new Error('The active Lottie loop did not mount.'));
      }
    }, 12);
  }));
}

async function saveRecordedFlow(browser, filename, run) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'no-preference',
    recordVideo: {dir: outputDirectory, size: viewport},
  });
  const page = await context.newPage();
  const video = page.video();
  try {
    await run(page);
    await pause(page, 500);
  } finally {
    await page.close();
    if (video) await video.saveAs(path.join(outputDirectory, filename));
    await context.close();
  }
}

async function record(baseUrl) {
  await mkdir(outputDirectory, {recursive: true});
  for (const filename of await readdir(outputDirectory)) {
    if (filename.startsWith('page@') && filename.endsWith('.webm')) {
      await unlink(path.join(outputDirectory, filename));
    }
  }
  const browser = await chromium.launch({channel: 'msedge'});
  const recordings = [];
  const add = async (definition, run) => {
    await saveRecordedFlow(browser, definition.file, run);
    recordings.push(definition);
    process.stdout.write(`Recorded ${definition.file}.\n`);
  };

  try {
    // Compile the development route before video capture starts; a cold Vite
    // module graph otherwise leaves a long blank lead-in in the first study.
    const warmup = await browser.newPage();
    try {
      await warmup.goto(`${baseUrl}/?onboarded=1&service=memory`);
      await warmup.getByRole('searchbox', {name: 'Search files'}).waitFor();
      await warmup.evaluate(() => document.fonts.ready);
    } finally {
      await warmup.close();
    }
    await add({
      id: 'launcher-search',
      file: 'launcher-search.webm',
      title: 'Launcher search, selection, preview, scope, and open',
      flows: ['launcher open', 'typing expansion', 'rapid keyboard selection', 'preview details', 'scope change', 'folder open confirmation', 'file open confirmation'],
    }, async (page) => {
      await page.setViewportSize(collapsedViewport);
      await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
      const search = page.getByRole('searchbox', {name: 'Search files'});
      await search.waitFor();
      await pause(page, 500);
      await page.setViewportSize(expandedViewport);
      await search.pressSequentially('report', {delay: 70});
      await sustainSearchActivity(page);
      await page.getByRole('grid', {name: 'Search results'}).waitFor();
      await pause(page);
      await page.keyboard.press('ArrowDown');
      await pause(page, 180);
      await page.keyboard.press('ArrowDown');
      await pause(page, 180);
      await page.keyboard.press('ArrowUp');
      await pause(page);
      await page.keyboard.press('Alt+Enter');
      await page.getByRole('dialog', {name: 'File details'}).waitFor();
      await pause(page, 600);
      await page.keyboard.press('Escape');
      await pause(page);
      await page.keyboard.press('Control+Enter');
      await pause(page);
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowRight');
      await pause(page);
      await page.keyboard.press('Control+K');
      await pause(page);
      await page.keyboard.press('Enter');
    });

    await add({
      id: 'settings-routing',
      file: 'settings-routing.webm',
      title: 'Settings navigation and operational routes',
      flows: ['settings navigation', 'appearance', 'local AI route', 'AgentGateway route', 'privacy controls'],
    }, async (page) => {
      await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
      await page.getByRole('searchbox', {name: 'Search files'}).waitFor();
      await page.keyboard.press('Control+,');
      await page.getByRole('navigation', {name: 'Settings'}).waitFor();
      for (const pageName of ['Appearance', 'Local AI', 'AgentGateway', 'Privacy']) {
        await page.getByRole('tab', {name: pageName, exact: true}).click();
        await page.getByRole('heading', {name: pageName, exact: true}).waitFor();
        await pause(page, 520);
      }
      await page.getByRole('button', {name: 'Close settings'}).click();
      await page.setViewportSize(collapsedViewport);
    });

    await add({
      id: 'onboarding',
      file: 'onboarding.webm',
      title: 'Onboarding scene progression',
      flows: ['welcome', 'root selection', 'shortcut', 'answer mode', 'initial indexing', 'completion'],
    }, async (page) => {
      await page.goto(`${baseUrl}/?onboarding=1`);
      await page.getByRole('heading', {name: 'Everything, within reach'}).waitFor();
      await pause(page, 650);
      await page.getByRole('button', {name: 'Begin'}).click();
      await pause(page, 520);
      await page.getByRole('button', {name: 'Choose folder'}).click();
      await page.getByText('C:\\Projects\\Lumen Demo').waitFor();
      await pause(page, 520);
      for (let index = 0; index < 2; index += 1) {
        await page.getByRole('button', {name: 'Continue'}).click();
        await pause(page, 520);
      }
      await page.getByRole('button', {name: 'Start using Lumen'}).click();
      await page.setViewportSize(collapsedViewport);
    });

    await add({
      id: 'answer-submission',
      file: 'answer-submission.webm',
      title: 'Explicit answer submission, isolated failure, retry, and dismissal',
      flows: ['collapsed launcher', 'typing expansion', 'Enter-to-answer', 'answer failure isolation', 'retry', 'dismissal'],
    }, async (page) => {
      await page.setViewportSize(collapsedViewport);
      await page.goto(`${baseUrl}/?onboarded=1&service=memory`);
      const search = page.getByRole('searchbox', {name: 'Search files'});
      await search.waitFor();
      await pause(page, 500);
      await page.setViewportSize(expandedViewport);
      await search.pressSequentially('report', {delay: 70});
      await page.getByRole('grid', {name: 'Search results'}).waitFor();
      await pause(page);
      await search.press('Enter');
      await page.getByTestId('answer-region').waitFor();
      await pause(page, 700);
      await page.getByRole('button', {name: 'Retry answer'}).click();
      await pause(page, 700);
      await page.keyboard.press('Escape');
      await search.waitFor();
      await page.setViewportSize(collapsedViewport);
      await pause(page, 500);
      await page.keyboard.press('Escape');
      await page.locator('[data-launcher-visible="false"]').waitFor({state: 'attached'});
    });

    await add({
      id: 'answer-approval-states',
      file: 'answer-approval-states.webm',
      title: 'Streaming, stop, completion, and Computer Use approval controls',
      flows: ['waiting', 'streaming', 'stop transition', 'completed answer', 'approval pause', 'approve transition', 'deny transition'],
    }, async (page) => {
      await page.goto(`${baseUrl}/?gallery=1&scenario=ai-waiting`);
      const scenarioSelect = page.locator('select[aria-label="Gallery scenario"]');
      await scenarioSelect.waitFor();
      await pause(page, 500);
      await scenarioSelect.selectOption('ai-streaming');
      await page.getByRole('button', {name: 'Stop answer'}).focus();
      await pause(page, 650);
      await page.getByRole('button', {name: 'Stop answer'}).click();
      await page.getByText('Stopped', {exact: true}).waitFor();
      await page.getByRole('button', {name: 'Stop answer'}).waitFor({state: 'detached'});
      await pause(page, 450);
      await scenarioSelect.selectOption('ai-complete');
      await page.getByTestId('answer-region').waitFor();
      await pause(page, 650);
      await scenarioSelect.selectOption('computer-use-approval');
      const approval = page.getByRole('alertdialog', {name: 'Approve Computer Use action'});
      await approval.waitFor();
      await page.getByRole('button', {name: 'Approve once'}).focus();
      await pause(page, 450);
      await page.getByRole('button', {name: 'Approve once'}).click();
      await page.getByRole('status', {name: 'Working'}).waitFor();
      await page.getByText('Approved once in the deterministic gallery session').waitFor();
      await approval.waitFor({state: 'detached'});
      await pause(page, 650);
      await scenarioSelect.selectOption('ai-complete');
      await page.locator('[data-gallery-scenario="ai-complete"]').waitFor();
      await scenarioSelect.selectOption('computer-use-approval');
      await approval.waitFor();
      await page.getByRole('button', {name: 'Deny and stop'}).focus();
      await pause(page, 450);
      await page.getByRole('button', {name: 'Deny and stop'}).click();
      await page.getByRole('status', {name: 'Stopped'}).waitFor();
      await page.getByText('Denied and stopped in the deterministic gallery session').waitFor();
      await approval.waitFor({state: 'detached'});
      await pause(page, 650);
    });

    await add({
      id: 'activity-provider-states',
      file: 'activity-provider-states.webm',
      title: 'Gaming contraction and provider state routes',
      flows: ['gaming pause contraction', 'fullscreen pause', 'Cinema mode', 'GPU provider', 'model ready', 'gateway ready'],
    }, async (page) => {
      await page.goto(`${baseUrl}/?gallery=1&scenario=activity-indexing`);
      for (const scenario of [
        'activity-gaming',
        'activity-fullscreen',
        'activity-cinema',
        'provider-gpu',
        'model-ready',
        'gateway-ready',
      ]) {
        await page.locator('select[aria-label="Gallery scenario"]').selectOption(scenario);
        await page.locator(`[data-gallery-scenario="${scenario}"]`).waitFor();
        await pause(page, 650);
      }
    });
  } finally {
    await browser.close();
  }

  for (const filename of await readdir(outputDirectory)) {
    if (filename.startsWith('page@') && filename.endsWith('.webm')) {
      await unlink(path.join(outputDirectory, filename));
    }
  }

  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const manifest = {
    generatedAt: new Date().toISOString(),
    gitSha,
    browser: {name: 'Microsoft Edge'},
    viewport,
    reducedMotion: 'no-preference',
    count: recordings.length,
    recordings: recordings.map((item) => ({
      ...item,
      file: `artifacts/recordings/${item.file}`,
      deterministicAdapter: true,
      audio: false,
      gitSha,
    })),
  };
  await writeFile(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

await withLumenDevServer(record);
