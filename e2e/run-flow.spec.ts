import { rmSync } from "node:fs";
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

  // watch mode is clean; the operator panel appears with the debug toggle
  await expect(page.getByText(/Operator only/)).toHaveCount(0);
  await page.click("button:has-text('debug')");
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

test("live providers require an estimate and explicit confirmation", async ({
  page,
}) => {
  await page.goto("/experiments/nogame/A_baseline.yaml");
  const run = page.getByRole("button", { name: "Run", exact: true });

  // anthropic: dollar estimate with a budget, blocked until confirmed
  await page.selectOption("#launch-provider", "anthropic");
  await expect(page.getByText(/Estimated: ~\d+ calls/)).toBeVisible();
  await expect(page.getByText(/budget \$/)).toBeVisible();
  await expect(run).toBeDisabled();

  // claude_code: subscription wording and purity note, blocked until confirmed
  await page.selectOption("#launch-provider", "claude_code");
  await expect(page.getByText(/subscription's usage window/)).toBeVisible();
  await expect(page.getByText(/Purity note/)).toBeVisible();
  await expect(run).toBeDisabled();
  await page.check("input[type=checkbox]");
  // credentials exist in this environment, so confirming unblocks the launch
  await expect(run).toBeEnabled();
});

test("yaml editor validates, saves, and duplicates", async ({ page }) => {
  await page.goto("/experiments/nogame/A_baseline.yaml");
  await page.click("summary:has-text('Raw YAML')");
  const textarea = page.locator("details textarea");
  const original = await textarea.inputValue();

  // invalid edit is rejected with a field-naming error and not saved
  await textarea.fill(`${original}\nactivity:\n  p: 3\n`);
  await page.click("details button:has-text('Save')");
  await expect(page.getByText(/activity\.p/)).toBeVisible();

  // valid edit saves
  await textarea.fill(original.replace("name: A_baseline", "name: A_baseline"));
  await textarea.fill(original);
  await page.click("details button:has-text('Save')");
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  // duplicate creates a new condition file and navigates to it
  await page.fill('input[placeholder="new-file.yaml"]', "ZZ_e2e_copy.yaml");
  await page.click("details button:has-text('Duplicate')");
  await page.waitForURL(/ZZ_e2e_copy\.yaml/);
  await page.click("summary:has-text('Raw YAML')");
  await expect(page.locator("details textarea")).toHaveValue(
    /name: ZZ_e2e_copy/,
  );
  rmSync("experiments/nogame/ZZ_e2e_copy.yaml", { force: true });
});

test("batch from the browser: run, table, replay a member", async ({
  page,
}) => {
  await page.goto("/experiments/nogame/J_batch.yaml");
  await page.fill("#batch-n", "3");
  await page.click("button:has-text('Run batch')");
  await page.waitForURL(/\/batches\//, { timeout: 60_000 });
  await expect(page.getByText(/3\/3 runs/)).toBeVisible();
  // analyzed table renders with one row per seed
  await expect(page.locator("table tbody tr")).toHaveCount(3);
  // open one member run as a replay
  await page.click("a[href*='%2F']");
  await expect(page.getByText("replay", { exact: true })).toBeVisible();
  await expect(page.locator("p.whitespace-pre-wrap").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("moderator: inject, mute, stop a live run", async ({ page }) => {
  // slow speed keeps the run alive while we moderate
  const response = await page.request.post("/api/runs", {
    data: {
      experiment: "nogame",
      file: "A_baseline.yaml",
      provider: "mock",
      duration: 7200,
      speed: 1,
    },
  });
  const { runId } = (await response.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await page.click("button:has-text('debug')");
  await expect(page.getByText(/Moderator — actions apply now/)).toBeVisible();

  // inject to all agents; it shows up in the operator panel
  await page.fill(
    'input[placeholder="private injection text…"]',
    "OP-PHASE-TEST",
  );
  await page.click("button:has-text('Inject')");
  await expect(page.getByText(/OP-PHASE-TEST/).first()).toBeVisible({
    timeout: 10_000,
  });

  // mute agent A; the panel marks it
  await page.selectOption('select[aria-label="room agent"]', "A");
  await page.click("button:has-text('Mute')");
  await expect(page.getByText("muted", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // stop the run
  page.on("dialog", (dialog) => dialog.accept());
  await page.click("button:has-text('stop')");
  await expect(page.getByText("done", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("designer: edit prompts in the form and save as a new variation", async ({
  page,
}) => {
  await page.goto("/experiments/nogame/A_baseline.yaml");
  await expect(page.getByText("The universal prompt")).toBeVisible();

  // add a private note through the form
  await page.click("button:has-text('+ private note')");
  await page.fill(
    'input[placeholder="what only this agent is told…"]',
    "You secretly love the color RED.",
  );
  // tweak a knob too
  await page.fill("#designer-words", "30");

  await page.fill(
    'input[placeholder="save as new variation…"]',
    "ZZ_form_test",
  );
  await page.click("button:has-text('Save as')");
  await page.waitForURL(/ZZ_form_test\.yaml/);

  // the saved file is a minimal patch over what it extends
  await page.click("summary:has-text('Raw YAML')");
  const yaml = await page.locator("details textarea").inputValue();
  expect(yaml).toContain("extends: ./base.yaml");
  expect(yaml).toContain("You secretly love the color RED.");
  expect(yaml).toContain("max_words: 30");
  expect(yaml).toContain("name: ZZ_form_test");
  rmSync("experiments/nogame/ZZ_form_test.yaml", { force: true });
});
