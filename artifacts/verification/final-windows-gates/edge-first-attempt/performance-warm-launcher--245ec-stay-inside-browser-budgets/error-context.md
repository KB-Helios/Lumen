# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: performance.spec.ts >> warm launcher and ordinary interactions stay inside browser budgets
- Location: tests\e2e\performance.spec.ts:110:1

# Error details

```
Error: expect(received).toBeLessThan(expected)

Expected: < 3
Received:   10.399999996647239
```

# Page snapshot

```yaml
- application "Lumen" [ref=e3]:
  - main [ref=e4]:
    - generic "Lumen launcher" [ref=e6]:
      - generic [ref=e8]:
        - generic [ref=e10]:
          - button "Switch to Computer Use" [ref=e17]:
            - generic [ref=e20]: Computer Use
          - search "File search" [ref=e21]:
            - searchbox "Search files" [active] [ref=e22]: report
            - button "Clear search" [ref=e24]
          - generic "Alt plus Space" [ref=e27]: Alt Space
        - generic [ref=e28]:
          - generic [ref=e29]:
            - tablist "Search scopes" [ref=e32]:
              - tab "All" [selected] [ref=e33]
              - tab "Files" [ref=e35]
              - tab "Folders" [ref=e36]
              - tab "Documents" [ref=e37]
              - tab "Code" [ref=e38]
              - tab "Images" [ref=e39]
            - region "Search workspace" [ref=e41]:
              - region "Search result list" [ref=e44]:
                - generic [ref=e45]:
                  - generic [ref=e46]: Local results
                  - generic [ref=e47]: 3 results
                - grid "Search results" [ref=e49]:
                  - row "Quarterly report.pdf, C:\\Lumen Demo\\Reports\\Quarterly report.pdf, Name" [selected] [ref=e50]:
                    - gridcell "Quarterly report.pdf PDF C:\\Lumen Demo\\Reports\\Quarterly report.pdf Name 18 KB" [ref=e51]:
                      - generic [ref=e59]:
                        - generic [ref=e60]:
                          - generic [ref=e61]: Quarterly report.pdf
                          - generic [ref=e62]: PDF
                        - generic "C:\\Lumen Demo\\Reports\\Quarterly report.pdf" [ref=e64]
                      - generic [ref=e65]: Name
                      - generic [ref=e66]: 18 KB
                      - generic [ref=e67]: Enter
                  - row "report-summary.md, C:\\Lumen Demo\\Notes\\report-summary.md, Content" [ref=e68]:
                    - gridcell "report-summary.md MD C:\\Lumen Demo\\Notes\\report-summary.md Release summary and operating highlights Content 18 KB" [ref=e69]:
                      - generic [ref=e76]:
                        - generic [ref=e77]:
                          - generic [ref=e78]: report-summary.md
                          - generic [ref=e79]: MD
                        - generic [ref=e80]:
                          - generic "C:\\Lumen Demo\\Notes\\report-summary.md" [ref=e81]
                          - generic [ref=e82]: Release summary and operating highlights
                      - generic [ref=e83]: Content
                      - generic [ref=e84]: 18 KB
                      - generic [ref=e85]: Enter
                  - row "Årsrapport 2026 – 東京 終.docx, C:\\Lumen Demo\\International\\Årsrapport 2026 – 東京 終.docx, Meaning" [ref=e86]:
                    - gridcell "Årsrapport 2026 – 東京 終.docx DOCX C:\\Lumen Demo\\International\\Årsrapport 2026 – 東京 終.docx Annual report, international edition Meaning 18 KB" [ref=e87]:
                      - generic [ref=e94]:
                        - generic [ref=e95]:
                          - generic [ref=e96]: Årsrapport 2026 – 東京 終.docx
                          - generic [ref=e97]: DOCX
                        - generic [ref=e98]:
                          - generic "C:\\Lumen Demo\\International\\Årsrapport 2026 – 東京 終.docx" [ref=e99]
                          - generic [ref=e100]: Annual report, international edition
                      - generic [ref=e101]: Meaning
                      - generic [ref=e102]: 18 KB
                      - generic [ref=e103]: Enter
              - generic "Result actions" [ref=e104]:
                - generic "C:\\Lumen Demo\\Reports\\Quarterly report.pdf" [ref=e105]: Quarterly report.pdf
                - button "Open selected result" [ref=e106]:
                  - generic [ref=e109]: Open
                  - generic [ref=e110]: ↵
                - button "Open containing folder" [ref=e111]:
                  - generic [ref=e114]: Folder
                - button "Pin selected result" [disabled] [ref=e115]:
                  - generic [ref=e118]: Pin
                - button "Show file details" [ref=e119]:
                  - generic [ref=e123]: Details
              - generic [ref=e124]: 3 results. Quarterly report.pdf selected
          - generic [ref=e125]:
            - status [ref=e126]:
              - generic [ref=e129]: 3 results
            - generic [ref=e130]: Local runtime
```

# Test source

```ts
  101 | }
  102 | 
  103 | async function measureFrameCadence(page: Page, sampleCount = 60) {
  104 |   const cadence = await page.evaluate(sampleFrameCadence, {sampleCount});
  105 |   expect(cadence.intervals).toHaveLength(sampleCount);
  106 |   expect(cadence.p95Ms).not.toBeNull();
  107 |   return cadence;
  108 | }
  109 | 
  110 | test('warm launcher and ordinary interactions stay inside browser budgets', async ({page}) => {
  111 |   test.setTimeout(60_000);
  112 |   await page.setViewportSize({width: 800, height: 540});
  113 |   await page.goto('/?onboarded=1&service=memory');
  114 |   const search = page.getByRole('searchbox', {name: 'Search files'});
  115 |   await expect(search).toBeFocused();
  116 | 
  117 |   for (let index = 0; index < 6; index += 1) {
  118 |     await hideAndReshowLauncher(page, search);
  119 |   }
  120 |   await page.waitForTimeout(100);
  121 |   await resetMetrics(page);
  122 | 
  123 |   for (let index = 1; index <= 24; index += 1) {
  124 |     await hideAndReshowLauncher(page, search);
  125 |     await waitForSamples(page, 'launcher-visible', index);
  126 |   }
  127 |   const warmMetrics = await readMetrics(page);
  128 |   const warmOpenP95 = percentile(
  129 |     warmMetrics.timings.filter((sample) => sample.name === 'launcher-visible').map((sample) => sample.durationMs),
  130 |     0.95,
  131 |   );
  132 |   expect(warmOpenP95).toBeLessThan(20);
  133 | 
  134 |   await resetMetrics(page);
  135 |   for (let index = 1; index <= 30; index += 1) {
  136 |     await search.fill(`report-${index}`);
  137 |     await waitForSamples(page, 'input-response', index);
  138 |     await waitForSamples(page, 'input-next-frame', index);
  139 |     await page.waitForTimeout(40);
  140 |   }
  141 |   const inputMetrics = await readMetrics(page);
  142 |   await search.fill('report');
  143 |   await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  144 |   const frameCadence = await measureFrameCadence(page);
  145 |   const observedFrameBudget = Math.max(frameCadence.p95Ms!, 1000 / 240) +
  146 |     frameSchedulingToleranceMs;
  147 |   const inputP95 = percentile(
  148 |     inputMetrics.timings.filter((sample) => sample.name === 'input-response').map((sample) => sample.durationMs),
  149 |     0.95,
  150 |   );
  151 |   expect(inputP95).toBeLessThan(observedFrameBudget);
  152 |   const inputFrameSamples = inputMetrics.timings.filter((sample) => sample.name === 'input-next-frame');
  153 |   expect(inputFrameSamples).toHaveLength(30);
  154 |   expect(percentile(inputFrameSamples.map((sample) => sample.durationMs), 0.95)).toBeLessThan(observedFrameBudget);
  155 |   await resetMetrics(page);
  156 |   const ordinaryQueries = ['report', 'design', 'project', ''];
  157 |   const ordinaryMetrics: DiagnosticsMetrics = {timings: [], reactCommits: [], browserLongTasks: []};
  158 |   for (let index = 0; index < 24; index += 1) {
  159 |     await resetMetrics(page);
  160 |     await search.fill(ordinaryQueries[index % ordinaryQueries.length]);
  161 |     await page.waitForTimeout(250);
  162 |     const queryMetrics = await readMetrics(page);
  163 |     ordinaryMetrics.reactCommits.push(...queryMetrics.reactCommits);
  164 |     ordinaryMetrics.browserLongTasks.push(...queryMetrics.browserLongTasks);
  165 |   }
  166 |   const ordinaryReactCommits = ordinaryMetrics.reactCommits;
  167 |   expect(ordinaryReactCommits.length).toBeGreaterThan(0);
  168 |   expect(ordinaryMetrics.browserLongTasks).toHaveLength(0);
  169 | 
  170 |   await resetMetrics(page);
  171 |   const rapidBurst = await dispatchRapidInputBurst(search);
  172 |   await waitForSamples(page, 'input-response', 30);
  173 |   await page.waitForTimeout(100);
  174 |   const rapidBurstMetrics = await readMetrics(page);
  175 |   await expect(search).toHaveValue('rapid-burst-30');
  176 |   expect(rapidBurst.synchronousDurationMs).toBeLessThan(16);
  177 |   expect(rapidBurstMetrics.browserLongTasks).toHaveLength(0);
  178 |   await search.fill('report');
  179 |   await expect(page.getByRole('row').first()).toBeVisible();
  180 | 
  181 |   for (let index = 0; index < 12; index += 1) {
  182 |     await page.keyboard.press(index % 2 === 0 ? 'ArrowDown' : 'ArrowUp');
  183 |     await page.waitForTimeout(12);
  184 |   }
  185 |   await page.waitForTimeout(100);
  186 | 
  187 |   await resetMetrics(page);
  188 |   for (let index = 1; index <= 120; index += 1) {
  189 |     await page.keyboard.press(index % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
  190 |     await page.waitForTimeout(12);
  191 |   }
  192 |   await page.waitForTimeout(100);
  193 |   const selectionMetrics = await readMetrics(page);
  194 |   expect(selectionMetrics.timings.filter((sample) => sample.name === 'selection-paint')).toHaveLength(120);
  195 |   const selectionP95 = percentile(
  196 |     selectionMetrics.timings.filter((sample) => sample.name === 'selection-paint').map((sample) => sample.durationMs),
  197 |     0.95,
  198 |   );
  199 |   const ordinaryCommitP95 = percentile(ordinaryReactCommits, 0.95);
  200 |   expect(selectionP95).toBeLessThan(observedFrameBudget);
> 201 |   expect(ordinaryCommitP95).toBeLessThan(3);
      |                             ^ Error: expect(received).toBeLessThan(expected)
  202 |   expect(selectionMetrics.browserLongTasks).toHaveLength(0);
  203 | 
  204 |   await resetMetrics(page);
  205 |   const rapidSelection = await dispatchRapidSelectionBurst(search);
  206 |   await waitForSamples(page, 'selection-paint', 30);
  207 |   await page.waitForTimeout(100);
  208 |   const rapidSelectionMetrics = await readMetrics(page);
  209 |   await expect(page.locator('[data-result-id][data-selected="true"]')).toHaveCount(1);
  210 |   expect(rapidSelection.synchronousDurationMs).toBeLessThan(16);
  211 |   expect(rapidSelectionMetrics.browserLongTasks).toHaveLength(0);
  212 | });
  213 | 
  214 | test('hover, idle work, animation count, and browser heap remain bounded', async ({page, context}, testInfo) => {
  215 |   await page.setViewportSize({width: 800, height: 540});
  216 |   await page.goto('/?gallery=1&scenario=expanded-results&capture=1&theme=reduced-motion');
  217 |   const row = page.getByRole('row').first();
  218 |   await expect(row).toBeVisible();
  219 | 
  220 |   await resetMetrics(page);
  221 |   const hoverSamples = [];
  222 |   for (let index = 0; index < 80; index += 1) {
  223 |     hoverSamples.push(await sampleHover(row));
  224 |   }
  225 |   await page.waitForTimeout(100);
  226 |   const hoverToPaintSamples = hoverSamples.map((sample) => sample.responseMs);
  227 |   const hoverNominalFrameIntervals = hoverSamples.map((sample) => sample.nominalFrameIntervalMs);
  228 |   const hoverFrameIntervals = hoverSamples.map((sample) => sample.callbackIntervalMs);
  229 |   const hoverSynchronousDispatch = hoverSamples.map((sample) => sample.synchronousDispatchMs);
  230 |   const hoverMetrics = await readMetrics(page);
  231 |   const hoverFrameBudget = Math.max(percentile(hoverNominalFrameIntervals, 0.95), 1000 / 240);
  232 |   const hoverEvidence = {
  233 |     browserVersion: page.context().browser()?.version(),
  234 |     responseP95Ms: percentile(hoverToPaintSamples, 0.95),
  235 |     frameBudgetMs: hoverFrameBudget,
  236 |     readySamples: hoverSamples.filter((sample) => sample.ready).length,
  237 |     callbackOffsetGrowthP95Ms: percentile(hoverSamples.map((sample) =>
  238 |       sample.endCallbackOffsetMs - sample.startCallbackOffsetMs), 0.95),
  239 |     callbackIntervalP95Ms: percentile(hoverFrameIntervals, 0.95),
  240 |     samples: hoverSamples,
  241 |   };
  242 |   await testInfo.attach('hover-timing-samples', {
  243 |     body: JSON.stringify(hoverEvidence, null, 2), contentType: 'application/json',
  244 |   });
  245 |   console.info('hover-performance', JSON.stringify({...hoverEvidence, samples: undefined}));
  246 |   // Use the same independent nominal cadence budget as the evidence profiler.
  247 |   // Readiness additionally checks state and the intended color.
  248 |   expect(hoverSamples.filter((sample) => !sample.ready)).toEqual([]);
  249 |   expect(percentile(hoverToPaintSamples, 0.95)).toBeLessThanOrEqual(hoverFrameBudget);
  250 |   expect(Math.max(...hoverSynchronousDispatch)).toBeLessThan(16);
  251 |   expect(hoverMetrics.browserLongTasks).toHaveLength(0);
  252 | 
  253 |   await page.waitForTimeout(500);
  254 |   expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  255 | 
  256 |   const session = await context.newCDPSession(page);
  257 |   await session.send('Performance.enable');
  258 |   const before = await session.send('Performance.getMetrics');
  259 |   const startedAt = Date.now();
  260 |   await page.waitForTimeout(1000);
  261 |   const elapsedSeconds = (Date.now() - startedAt) / 1000;
  262 |   const after = await session.send('Performance.getMetrics');
  263 |   await session.send('HeapProfiler.collectGarbage');
  264 |   const afterGarbageCollection = await session.send('Performance.getMetrics');
  265 |   const metric = (items: typeof before.metrics, name: string) => items.find((item) => item.name === name)?.value ?? 0;
  266 |   const idleCpuPercent = (metric(after.metrics, 'TaskDuration') - metric(before.metrics, 'TaskDuration')) / elapsedSeconds * 100;
  267 |   const heapMegabytes = metric(afterGarbageCollection.metrics, 'JSHeapUsedSize') / (1024 * 1024);
  268 | 
  269 |   expect(idleCpuPercent).toBeLessThan(2);
  270 |   expect(heapMegabytes).toBeLessThan(100);
  271 | });
  272 | 
  273 | test('the static palette keeps one answer region and exposes diagnostics instrumentation', async ({page}) => {
  274 |   await page.setViewportSize({width: 800, height: 540});
  275 |   await page.goto('/?gallery=1&scenario=ai-streaming&capture=1');
  276 | 
  277 |   await expect(page.getByTestId('answer-region')).toHaveCount(1);
  278 |   await expect(page.getByRole('button', {name: 'Stop answer'})).toBeVisible();
  279 |   await page.waitForTimeout(250);
  280 |   await page.waitForFunction(
  281 |     () => document.getAnimations().every((animation) => animation.playState !== 'running'),
  282 |   );
  283 |   await page.waitForTimeout(500);
  284 |   expect(await page.evaluate(
  285 |     () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
  286 |   )).toBe(0);
  287 | 
  288 |   const metrics = await readMetrics(page);
  289 |   expect(Array.isArray(metrics.timings)).toBe(true);
  290 |   expect(Array.isArray(metrics.reactCommits)).toBe(true);
  291 | });
  292 | 
```