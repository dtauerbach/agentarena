import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { runEngine } from "./engine";
import { createRunLogger, makeRunDir } from "./log";
import { makeMockProvider } from "./providers/mock";
import { verifyRun } from "./verify";

let runDir: string;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "arena-verify-"));
  const config = loadConfig("experiments/mafia/auto.yaml", {
    provider: "mock",
    duration: 1200,
  });
  runDir = makeRunDir(config, base);
  const logger = createRunLogger(runDir);
  logger.writeResolvedConfig(config);
  await runEngine(config, makeMockProvider(config.seed), logger.hooks);
  await logger.close();
});

describe("run verifier", () => {
  it("passes a genuine mock run (live-only checks skip)", () => {
    const report = verifyRun(runDir);
    expect(report.ok).toBe(true);
    const byName = Object.fromEntries(
      report.checks.map((c) => [c.name, c.status]),
    );
    expect(byName["artifacts present"]).toBe("PASS");
    expect(byName["every post has a logged call"]).toBe("PASS");
    expect(byName["token accounting reconciles"]).toBe("PASS");
    expect(byName["wall-clock coherence"]).toBe("PASS");
    expect(byName["server-issued call ids"]).toBe("SKIP");
    expect(byName["latency floor"]).toBe("SKIP");
    expect(report.externalCrossCheck.join(" ")).toContain("Mock run");
  });

  it("fails loudly on forged tokens and a deleted call", () => {
    const tampered = mkdtempSync(join(tmpdir(), "arena-tampered-"));
    cpSync(runDir, tampered, { recursive: true });
    const lines = readFileSync(join(tampered, "calls.jsonl"), "utf8")
      .trim()
      .split("\n");
    const forged = JSON.parse(lines[2] as string);
    forged.response.usage.outputTokens += 999;
    lines[2] = JSON.stringify(forged);
    lines.splice(10, 1); // delete a call outright
    writeFileSync(join(tampered, "calls.jsonl"), `${lines.join("\n")}\n`);

    const report = verifyRun(tampered);
    expect(report.ok).toBe(false);
    const failed = report.checks
      .filter((c) => c.status === "FAIL")
      .map((c) => c.name);
    expect(failed).toContain("token accounting reconciles");
  });

  it("fails when artifacts are missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "arena-empty-"));
    const report = verifyRun(empty);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.status).toBe("FAIL");
  });
});
