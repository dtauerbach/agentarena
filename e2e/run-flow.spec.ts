import { expect, test } from "@playwright/test";

test("launch a mock run, watch posts land, pause, finish, replay", async ({
  page,
}) => {
  await page.goto("/");
  await page.click("text=A_baseline.yaml");

  // launch at 60x so posts land while we watch
  await page.locator('input[inputmode="numeric"]').first().fill("900");
  await page.selectOption("#launch-speed", "60");
  await page.click("button:has-text('Run')");
  await page.waitForURL(/\/runs\//);
  await expect(page.getByText("live", { exact: true })).toBeVisible();

  // operator panel is on by default and clearly marked
  await expect(page.getByText(/Operator only/)).toBeVisible();
  await expect(
    page.getByText(/last checked|composing since|not seen yet/).first(),
  ).toBeVisible({
    timeout: 15_000,
  });

  // posts land over time on the live board
  await expect(page.locator("p.whitespace-pre-wrap").first()).toBeVisible({
    timeout: 20_000,
  });
  const early = await page.locator("p.whitespace-pre-wrap").count();

  // pause halts the simulated clock
  await page.click("button:has-text('pause')");
  await page.waitForTimeout(500);
  const clock1 = await page.locator("span.font-mono.text-lg").innerText();
  await page.waitForTimeout(1200);
  await expect(page.locator("span.font-mono.text-lg")).toHaveText(clock1);
  await page.click("button:has-text('resume')");

  // crank to max and let the run finish (it may already have finished)
  const liveMax = page.locator("button:has-text('max')");
  if (await liveMax.isEnabled()) await liveMax.click();
  await expect(page.getByText("done", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const finalPosts = await page.locator("p.whitespace-pre-wrap").count();
  expect(finalPosts).toBeGreaterThanOrEqual(early);
  const runUrl = page.url();

  // reopen the finished run: same board arrives as a replay
  await page.goto("/");
  await page.goto(runUrl);
  await expect(page.getByText("replay", { exact: true })).toBeVisible();
  await expect(page.locator("p.whitespace-pre-wrap").first()).toBeVisible({
    timeout: 20_000,
  });
  await page.click("button:has-text('max')");
  await expect(page.getByText("done", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("p.whitespace-pre-wrap")).toHaveCount(finalPosts);
  await page.screenshot({ path: "test-results/w1-replay.png" });
});

test("live provider requires an estimate and explicit confirmation", async ({
  page,
}) => {
  await page.goto("/experiments/nogame/A_baseline.yaml");
  await page.selectOption("#launch-provider", "anthropic");
  await expect(page.getByText(/Estimated: ~\d+ calls/)).toBeVisible();
  // no key in this environment: launch stays blocked even after confirming
  await expect(page.getByText(/ANTHROPIC_API_KEY is not set/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
  await page.check("input[type=checkbox]");
  await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
});
