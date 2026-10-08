import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: 2,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    viewport: { width: 1500, height: 1000 },
    timezoneId: 'America/Los_Angeles',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm exec vite -- --port 8099',
    url: 'http://127.0.0.1:8099',
    reuseExistingServer: false,
  },
});
