import {readFileSync} from 'node:fs';
import {chromium} from '@playwright/test';

// Use the repository's Node-hosted Playwright pattern; Bun remains the command/bundler.
const source = readFileSync(0, 'utf8');
const browser = await chromium.launch({channel: 'msedge', headless: true, timeout: 15_000});
try {
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:43187/**', (route) => route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Lumen passive host probe</title><body>Passive capability probe</body></html>'}));
  await page.goto('http://127.0.0.1:43187/');
  const evidence = await page.evaluate(async (sourceText) => {
    const blobUrl = globalThis.URL.createObjectURL(new globalThis.Blob([sourceText], {type: 'text/javascript'}));
    try {
      const {EdgeAiService} = await import(blobUrl);
      const service = new EdgeAiService();
      const names = ['LanguageModel', 'Summarizer', 'Writer', 'Rewriter', 'LanguageDetector', 'Translator', 'SpeechRecognition', 'webkitSpeechRecognition'];
      const presence = Object.fromEntries(names.map((name) => [name, name in globalThis]));
      const features = await service.status({edgeEnabled: true, textToolsEnabled: true, dictationEnabled: true, sourceLanguage: 'en', targetLanguage: 'sv', speechLanguage: 'en-US'});
      service.dispose();
      return {secureContext: globalThis.isSecureContext, userAgent: globalThis.navigator.userAgent, presence, features};
    } finally {globalThis.URL.revokeObjectURL(blobUrl);}
  }, source);
  globalThis.console.log(JSON.stringify({browserVersion: browser.version(), ...evidence}));
} finally {await browser.close();}
