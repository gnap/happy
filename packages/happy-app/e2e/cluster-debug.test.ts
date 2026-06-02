import { test, expect } from '@playwright/test';

/**
 * Cluster debug harness: verifies card counts for all scenarios.
 */

test.describe('Cluster Debug', () => {
    test('all scenario card counts', async ({ page }) => {
        await page.goto('/dev/timeline-demo');

        const expectedCards = [
            1, // 0: 单任务生命周期
            1, // 1: 三个并发任务
            1, // 2: Tool Call 吸收
            1, // 3: 前向吸收
            0, // 4: 无任务
            1, // 5: 过时 TaskUpdate
            0, // 6: 空输入
            2, // 7: 多回合 (2 user-text → 2 turns → 2 cards)
            1, // 8: 无user-text多batch (1 turn → 1 card)
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
