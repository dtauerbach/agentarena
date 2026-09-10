import { defineConfig } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: "npm run dev",
    port,
    reuseExistingServer: true,
  },
});
