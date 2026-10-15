# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: accessibility.spec.ts >> keyboard-only search, selection, details, and focus restoration remain complete
- Location: tests\e2e\accessibility.spec.ts:24:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('dialog', { name: 'File details' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('dialog', { name: 'File details' })

```

```yaml
- application "Lumen":
  - main:
    - button "Switch to Computer Use": Computer Use
    - search "File search":
      - searchbox "Search files": report
      - button "Clear search"
    - text: Alt Space
    - tablist "Search scopes":
      - tab "All" [selected]
      - tab "Files"
      - tab "Folders"
      - tab "Documents"
      - tab "Code"
      - tab "Images"
    - region "Search workspace":
      - region "AI answer":
        - text: AI answer Answer unavailable
        - group "Answer runtime":
          - text: Answer runtime
          - radio "Auto" [checked]
          - text: Auto
          - radio "Local"
          - text: Local
          - radio "Cloud"
          - text: Cloud
        - button "Retry answer": Retry
        - text: The answer runtime is not ready. Local search is still available.
      - region "Search result list":
        - text: Local results 3 results
        - grid "Search results":
          - row "Quarterly report.pdf, C:\\Lumen Demo\\Reports\\Quarterly report.pdf, Name":
            - gridcell "Quarterly report.pdf PDF C:\\Lumen Demo\\Reports\\Quarterly report.pdf Name 18 KB"
          - row "report-summary.md, C:\\Lumen Demo\\Notes\\report-summary.md, Content" [selected]:
            - gridcell "report-summary.md MD C:\\Lumen Demo\\Notes\\report-summary.md Release summary and operating highlights Content 18 KB"
          - row "Årsrapport 2026 – 東京 終.docx, C:\\Lumen Demo\\International\\Årsrapport 2026 – 東京 終.docx, Meaning":
            - gridcell "Årsrapport 2026 – 東京 終.docx DOCX C:\\Lumen Demo\\International\\Årsrapport 2026 – 東京 終.docx Annual report, international edition Meaning 18 KB"
      - text: report-summary.md
      - button "Open selected result": Open
      - button "Open containing folder": Folder
      - button "Pin selected result" [disabled]: Pin
      - button "Show file details": Details
      - text: 3 results. report-summary.md selected
    - status: 3 results
    - text: Local runtime
```

# Test source

```ts
  1   | import {expect, test} from '@playwright/test';
  2   | 
  3   | async function expectNamedInteractiveControls(page: import('@playwright/test').Page) {
  4   |   const controls = page.locator('button, input, select:not([tabindex="-1"]), [role="tab"], [role="row"]');
  5   |   const visible = [];
  6   |   for (let index = 0; index < await controls.count(); index += 1) {
  7   |     if (await controls.nth(index).isVisible()) visible.push(controls.nth(index));
  8   |   }
  9   |   expect(visible.length).toBeGreaterThan(0);
  10  |   for (const control of visible) {
  11  |     await expect(control).toHaveAccessibleName(/\S+/);
  12  |   }
  13  | }
  14  | 
  15  | test('core launcher and preview controls have accessible names and live status', async ({page}) => {
  16  |   await page.goto('/?gallery=1&scenario=preview-loading&capture=1');
  17  | 
  18  |   await expect(page.getByRole('region', {name: 'Lumen visual state gallery'})).toBeVisible();
  19  |   await expectNamedInteractiveControls(page);
  20  |   await expect(page.getByRole('region', {name: 'File preview'})).toContainText(/Loading preview|Preparing preview/);
  21  |   await expect(page.getByTestId('search-announcement')).toHaveAttribute('aria-live', 'polite');
  22  | });
  23  | 
  24  | test('keyboard-only search, selection, details, and focus restoration remain complete', async ({page}) => {
  25  |   await page.goto('/?onboarded=1&service=memory');
  26  |   const search = page.getByRole('searchbox', {name: 'Search files'});
  27  |   await expect(search).toBeFocused();
  28  |   await search.fill('report');
  29  |   await expect(page.getByRole('grid', {name: 'Search results'})).toBeVisible();
  30  | 
  31  |   await page.keyboard.press('ArrowDown');
  32  |   const selected = page.locator('[role="row"][aria-selected="true"]');
  33  |   await expect(selected).toHaveCount(1);
  34  |   await page.keyboard.press('Alt+Enter');
> 35  |   await expect(page.getByRole('dialog', {name: 'File details'})).toBeVisible();
      |                                                                  ^ Error: expect(locator).toBeVisible() failed
  36  |   await page.keyboard.press('Escape');
  37  |   await expect(search).toBeFocused();
  38  | 
  39  |   await page.keyboard.press('Control+,');
  40  |   await expect(page.getByRole('navigation', {name: 'Settings'})).toBeVisible();
  41  |   await expectNamedInteractiveControls(page);
  42  |   await page.keyboard.press('Escape');
  43  |   await expect(search).toBeFocused();
  44  | });
  45  | 
  46  | test('the keyboard map keeps one labelled composer and answer region available', async ({page}) => {
  47  |   await page.goto('/?onboarded=1&service=memory');
  48  |   const search = page.getByRole('searchbox', {name: 'Search files'});
  49  |   await expect(search).toBeFocused();
  50  | 
  51  |   await search.fill('report');
  52  |   await page.keyboard.press('Control+k');
  53  |   await expect(search).toBeFocused();
  54  |   await page.keyboard.press('Enter');
  55  |   await expect(page.getByRole('region', {name: 'AI answer'})).toBeVisible();
  56  |   await expect(page.getByTestId('answer-region')).toHaveCount(1);
  57  | 
  58  |   await page.goto('/?gallery=1&scenario=ai-streaming&capture=1');
  59  |   await expect(page.getByRole('button', {name: 'Stop answer'})).toBeEnabled();
  60  |   await expect(page.getByTestId('answer-region')).toHaveCount(1);
  61  | });
  62  | 
  63  | test('IME composition does not commit or expand until composition ends', async ({page}) => {
  64  |   await page.goto('/?onboarded=1&service=memory');
  65  |   const search = page.getByRole('searchbox', {name: 'Search files'});
  66  | 
  67  |   await search.dispatchEvent('compositionstart', {data: ''});
  68  |   await search.fill('Årsrapport');
  69  |   await expect(page.getByRole('region', {name: 'Search workspace'})).toHaveCount(0);
  70  |   await search.dispatchEvent('compositionend', {data: 'Årsrapport'});
  71  |   await expect(page.getByRole('region', {name: 'Search workspace'})).toBeVisible();
  72  | });
  73  | 
  74  | test('high contrast, reduced motion, opaque materials, Unicode, and status text are explicit', async ({page}) => {
  75  |   await page.goto('/?gallery=1&scenario=theme-high-contrast&capture=1');
  76  |   const application = page.getByRole('application', {name: 'Lumen'});
  77  |   await expect(application).toHaveAttribute('data-contrast', 'high');
  78  | 
  79  |   await page.goto('/?gallery=1&scenario=theme-reduced-motion&capture=1');
  80  |   await expect(application).toHaveAttribute('data-reduced-motion', 'true');
  81  |   const duration = await page.getByRole('tab', {name: 'All'}).evaluate((element) => getComputedStyle(element).transitionDuration);
  82  |   expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  83  | 
  84  |   await page.goto('/?gallery=1&scenario=theme-opaque&capture=1');
  85  |   await expect(application).toHaveAttribute('data-transparency', 'disabled');
  86  |   await expect(page.getByLabel('Lumen launcher')).toHaveCSS('backdrop-filter', 'none');
  87  | 
  88  |   await page.goto('/?gallery=1&scenario=unicode-filename&capture=1');
  89  |   await expect(page.getByRole('row', {name: /Årsrapport 2026/})).toContainText('東京');
  90  | 
  91  |   await page.goto('/?gallery=1&scenario=activity-battery&capture=1');
  92  |   await expect(page.getByTestId('activity-battery')).toContainText('Paused on battery');
  93  | });
  94  | 
  95  | test('all visible product targets are at least 32 logical pixels on one axis', async ({page}) => {
  96  |   await page.goto('/?gallery=1&scenario=preview-complete&capture=1');
  97  |   const targets = page.locator('button:visible, [role="tab"]:visible, [role="row"]:visible');
  98  |   const count = await targets.count();
  99  |   for (let index = 0; index < count; index += 1) {
  100 |     const box = await targets.nth(index).boundingBox();
  101 |     expect(box).not.toBeNull();
  102 |     expect(Math.max(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(32);
  103 |     expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
  104 |   }
  105 | });
  106 | 
```