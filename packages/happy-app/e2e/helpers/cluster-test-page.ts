import { Page, expect } from '@playwright/test';

export class ClusterTestPage {
    constructor(readonly page: Page) {}

    async goto(scenario?: number) {
        const url = scenario !== undefined
            ? `/dev/timeline-demo?scenario=${scenario}`
            : '/dev/timeline-demo';
        await this.page.goto(url);
    }

    async selectScenario(index: number) {
        const chips = this.page.locator('[data-testid^="scenario-chip-"]');
        await chips.nth(index).click();
    }

    get timeline() {
        return this.page.getByTestId('task-list-view');
    }

    getTaskRow(index: number) {
        return this.page.getByTestId(`task-row-${index}`);
    }

    getTaskChild(index: number) {
        return this.page.getByTestId(`task-child-${index}`);
    }

    getTaskTitle(index: number) {
        return this.page.getByTestId(`task-title-${index}`);
    }

    getTaskStatus(index: number) {
        return this.page.getByTestId(`task-status-${index}`);
    }

    async expectTimelineVisible() {
        await expect(this.timeline).toBeVisible();
    }

    async expectTimelineHidden() {
        await expect(this.timeline).toHaveCount(0);
    }

    async expectTaskCount(count: number) {
        for (let i = 0; i < count; i++) {
            await expect(this.getTaskRow(i)).toBeVisible();
        }
        // Shouldn't have extra tasks
        await expect(this.getTaskRow(count)).toHaveCount(0);
    }

    async expectTaskStatusText(index: number, text: string) {
        await expect(this.getTaskStatus(index)).toContainText(text);
    }
}
