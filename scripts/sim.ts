import type { ConfigOverrides } from "../src/lib/sim/config";
import { loadConfig } from "../src/lib/sim/config";
import { runEngine } from "../src/lib/sim/engine";
import { createRunLogger, makeRunDir } from "../src/lib/sim/log";
import { makeMockProvider } from "../src/lib/sim/providers/mock";
import type { Provider } from "../src/lib/sim/types";

function usage(): never {
  console.error(
    "usage: npm run sim -- run <config.yaml> [--provider mock|anthropic] [--duration SEC] [--seed N] [--model ID]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): {
  command: string;
  configPath: string;
  overrides: ConfigOverrides;
} {
  const [command, configPath, ...rest] = argv;
  if (command !== "run" || configPath === undefined) usage();
  const overrides: ConfigOverrides = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) usage();
    switch (flag) {
      case "--provider":
        if (value !== "mock" && value !== "anthropic") usage();
        overrides.provider = value;
        break;
      case "--duration":
        overrides.duration = Number(value);
        break;
      case "--seed":
        overrides.seed = Number(value);
        break;
      case "--model":
        overrides.model = value;
        break;
      default:
        usage();
    }
  }
  return { command, configPath, overrides };
}

async function main(): Promise<void> {
  const { configPath, overrides } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath, overrides);
  let provider: Provider;
  if (config.model.provider === "mock") {
    provider = makeMockProvider(config.seed);
  } else {
    throw new Error(
      "anthropic provider arrives in W2; run with --provider mock",
    );
  }
  const dir = makeRunDir(config);
  const logger = createRunLogger(dir);
  logger.writeResolvedConfig(config);
  console.log(`run dir: ${dir}`);
  const summary = await runEngine(config, provider, logger.hooks);
  await logger.close();
  console.log(
    `done: ${summary.posts} posts, ${summary.wakes} wakes (${summary.silences} silent), ${summary.calls} calls`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
