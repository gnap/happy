import { test, expect } from '@playwright/test';

/**
 * Cluster debug harness: verifies card counts for all scenarios.
 */

test.describe('Cluster Debug', () => {
    test('all scenario card counts', async ({ page }) => {
        await page.goto('/dev/timeline-demo');

        const expectedCards = [
            1, // 0
            1, // 1
            1, // 2
            1, // 3
            0, // 4
            1, // 5
            0, // 6
            2, // 7
            2, // 8 (无user-text多batch)
        ];

        for (let i = 0; i < expectedCards.length; i++) {
            const count = await page.evaluate((idx) => {
                const chips = document.querySelectorAll('[data-testid^="scenario-chip-"]');
                if (idx < chips.length) (chips[idx] as HTMLElement).click();
                return new Promise<number>(resolve => {
                    setTimeout(() => {
                        resolve(document.querySelectorAll('[data-testid="task-list-view"]').length);
                    }, 150);
                });
            }, i);
            expect(count, `Scenario ${i}`).toBe(expectedCards[i]);
        }
    });
});
