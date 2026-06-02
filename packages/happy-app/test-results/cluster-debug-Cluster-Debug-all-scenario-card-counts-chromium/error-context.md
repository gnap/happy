# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cluster-debug.test.ts >> Cluster Debug >> all scenario card counts
- Location: e2e/cluster-debug.test.ts:8:9

# Error details

```
Error: Scenario 0

expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 0
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e5]:
    - generic [ref=e6]:
      - heading "Something went wrong" [level=1] [ref=e7]
      - 'heading "Error: __globalTaskStatus is not defined" [level=2] [ref=e8]'
    - link "Sitemap" [ref=e10] [cursor=pointer]:
      - /url: /_sitemap
    - generic [ref=e13] [cursor=pointer]: Retry
  - generic:
    - img
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Cluster debug harness: verifies card counts for all scenarios.
  5  |  */
  6  | 
  7  | test.describe('Cluster Debug', () => {
  8  |     test('all scenario card counts', async ({ page }) => {
  9  |         await page.goto('/dev/timeline-demo');
  10 | 
  11 |         const expectedCards = [
  12 |             1, // 0
  13 |             1, // 1
  14 |             1, // 2
  15 |             1, // 3
  16 |             0, // 4
  17 |             1, // 5
  18 |             0, // 6
  19 |             2, // 7
  20 |             2, // 8 (无user-text多batch)
  21 |         ];
  22 | 
  23 |         for (let i = 0; i < expectedCards.length; i++) {
  24 |             const count = await page.evaluate((idx) => {
  25 |                 const chips = document.querySelectorAll('[data-testid^="scenario-chip-"]');
  26 |                 if (idx < chips.length) (chips[idx] as HTMLElement).click();
  27 |                 return new Promise<number>(resolve => {
  28 |                     setTimeout(() => {
  29 |                         resolve(document.querySelectorAll('[data-testid="task-list-view"]').length);
  30 |                     }, 150);
  31 |                 });
  32 |             }, i);
> 33 |             expect(count, `Scenario ${i}`).toBe(expectedCards[i]);
     |                                            ^ Error: Scenario 0
  34 |         }
  35 |     });
  36 | });
  37 | 
```