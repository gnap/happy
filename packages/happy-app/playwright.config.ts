import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : 1,
    reporter: 'html',
    timeout: 30000,
    expect: { timeout: 10000 },
    use: {
        baseURL: 'http://localhost:8081',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], channel: 'chromium' },
        },
    ],
    webServer: {
        command: 'BROWSER=none yarn web --port 8081',
        url: 'http://localhost:8081',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
    },
});
