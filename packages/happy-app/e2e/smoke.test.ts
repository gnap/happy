import { test, expect } from '@playwright/test';
import { ClusterTestPage } from './helpers/cluster-test-page';

test.describe('Timeline Demo - Navigation', () => {
    test('timeline-demo page loads via direct URL', async ({ page }) => {
        // Navigate directly to timeline demo page
        await page.goto('/dev/timeline-demo');
        // Should load and render the chip selector
        await expect(page.getByTestId('scenario-chip-0')).toBeVisible({ timeout: 15000 });
    });

});

test.describe('Timeline Demo - Single Task Lifecycle', () => {
    test('task-list-view renders', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(0); // 单任务生命周期
        await tp.expectTimelineVisible();
    });

    test('renders task row with title and status', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(0);
        await expect(tp.getTaskTitle(0)).toBeVisible();
        await expect(tp.getTaskStatus(0)).toBeVisible();
    });

    test('completed task shows completion status text', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(0);
        await tp.expectTaskStatusText(0, 'completed');
    });
});

test.describe('Timeline Demo - Multi-Task Rendering', () => {
    test('three tasks render correctly', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(1); // 三任务并发
        await tp.expectTimelineVisible();
        await tp.expectTaskCount(3);
    });

    test('tasks have independent status indicators', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(1);
        // Task A completed, Task B pending (never updated), Task C completed
        await tp.expectTaskStatusText(0, 'completed');
        await tp.expectTaskStatusText(1, 'waiting');
        await tp.expectTaskStatusText(2, 'completed');
    });
});

test.describe('Timeline Demo - Tool Call Absorption', () => {
    test('non-task tool calls hidden during active tasks', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(2); // Tool Call Absorption
        await tp.expectTimelineVisible();
        // Should show collapsed count in status label
        await tp.expectTaskStatusText(0, 'tool');
    });
});

test.describe('Timeline Demo - Backward Extension', () => {
    test('tool calls before TaskCreate absorbed', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(3); // Backward Extension
        await tp.expectTimelineVisible();
    });
});

test.describe('Timeline Demo - No Tasks', () => {
    test('no timeline card when no tasks', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(4); // No Tasks (passthrough)
        await tp.expectTimelineHidden();
    });
});

test.describe('Timeline Demo - Stale TaskUpdate', () => {
    test('stale TaskUpdate handled without crash', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(5); // Stale TaskUpdate
        await tp.expectTimelineVisible();
        await tp.expectTaskCount(1);
    });
});

test.describe('Timeline Demo - Multi-Turn', () => {
    test('two separate timeline cards for two turns', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(7); // 多回合 BUG 复现
        // Should have two timeline cards (one per turn)
        const timelines = page.getByTestId('task-list-view');
        await expect(timelines.first()).toBeVisible();
        await expect(timelines).toHaveCount(2);
    });
});

test.describe('Timeline Demo - Empty Input', () => {
    test('empty input shows no timeline', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(6); // Empty Input
        await tp.expectTimelineHidden();
    });
});

test.describe('Timeline Demo - Visual Regression', () => {
    test('single task lifecycle screenshot', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(0);
        await tp.expectTimelineVisible();
        await expect(page).toHaveScreenshot('timeline-single-task.png');
    });

    test('multi-task screenshot', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(1);
        await tp.expectTimelineVisible();
        await expect(page).toHaveScreenshot('timeline-multi-task.png');
    });

    test('no tasks passthrough screenshot', async ({ page }) => {
        const tp = new ClusterTestPage(page);
        await tp.goto(4);
        await expect(page).toHaveScreenshot('timeline-no-tasks.png');
    });
});
