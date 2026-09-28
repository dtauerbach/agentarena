import type { Config } from "./config";
import type { ModelRates } from "./pricing";
import { usd } from "./pricing";

export type CostEstimate = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null; // null when any involved model has no pricing entry
  budgetUsd: number;
  overBudget: boolean;
};

const TOKENS_PER_WORD = 1.4;
const PER_POST_OVERHEAD_TOKENS = 10; // "#id clock name: " framing
const PRIVATE_BLOCK_TOKENS = 60; // header + identity + status + instruction
const MODERATOR_OVERHEAD_TOKENS = 120; // room headers + tallies + memory + instruction

// SPEC §12: simulate the expected schedule — each wake posts with probability
// cost.assumed_post_rate at max_words words, growing the board; input per
// call is system + board so far + private block + instruction. Gate mode
// doubles calls; chat mode adds a revision call to a third of posts; a
// config moderator adds duration/cadence omniscient reads of the whole
// society, priced at its own model's rates.
export function estimateCost(
  config: Config,
  pricing: Record<string, ModelRates>,
  budgetUsd: number,
): CostEstimate {
  const wakesPerAgent =
    config.activity.mode === "ticks"
      ? (config.duration / config.activity.tick) * config.activity.p
      : config.duration / config.activity.mean_gap;
  const memberships = Object.values(config.rooms).reduce(
    (n, room) =>
      n + (room.members === "all" ? config.agents.count : room.members.length),
    0,
  );
  const wakes = Math.round(memberships * wakesPerAgent);
  const postTokens =
    config.output.max_words * TOKENS_PER_WORD + PER_POST_OVERHEAD_TOKENS;
  const systemTokens = Math.ceil(config.common_prompt.length / 4);
  const visibleCap =
    config.board.visibility === "full"
      ? Number.POSITIVE_INFINITY
      : config.board.visibility.last_n;

  let inputTokens = 0;
  let outputTokens = 0;
  let boardPosts = 0;
  for (let i = 0; i < wakes; i++) {
    const visible = Math.min(boardPosts, visibleCap);
    inputTokens += systemTokens + visible * postTokens + PRIVATE_BLOCK_TOKENS;
    outputTokens +=
      config.cost.assumed_post_rate * config.output.max_words * TOKENS_PER_WORD;
    boardPosts += config.cost.assumed_post_rate;
  }
  let calls = wakes;
  if (config.wake.mode === "gate") {
    calls *= 2;
    inputTokens *= 2; // the gate call reads the same board
    outputTokens += wakes; // one-token ACT/PASS replies
  }
  if (config.post.mode === "chat") {
    const revisions = (wakes * config.cost.assumed_post_rate) / 3;
    calls += Math.round(revisions);
    inputTokens +=
      revisions *
      (systemTokens + Math.min(boardPosts, visibleCap) * postTokens);
    outputTokens += revisions * config.output.max_words * TOKENS_PER_WORD;
  }
  inputTokens = Math.round(inputTokens);
  outputTokens = Math.round(outputTokens);

  // moderator calls are priced separately (its model may differ)
  let moderatorInput = 0;
  let moderatorOutput = 0;
  let moderatorCalls = 0;
  if (config.moderator) {
    moderatorCalls = Math.floor(config.duration / config.moderator.cadence);
    const moderatorSystem = Math.ceil(config.moderator.prompt.length / 4);
    for (let k = 1; k <= moderatorCalls; k++) {
      const boardAtK = (boardPosts * k) / Math.max(1, moderatorCalls);
      moderatorInput +=
        moderatorSystem + boardAtK * postTokens + MODERATOR_OVERHEAD_TOKENS;
    }
    moderatorOutput = moderatorCalls * (config.moderator.max_tokens / 2);
    moderatorInput = Math.round(moderatorInput);
    moderatorOutput = Math.round(moderatorOutput);
  }

  const agentRates = pricing[config.model.name];
  const moderatorRates = config.moderator
    ? pricing[config.moderator.model]
    : undefined;
  const cost =
    agentRates === undefined || (config.moderator && !moderatorRates)
      ? null
      : usd(agentRates, { input: inputTokens, output: outputTokens }) +
        (moderatorRates
          ? usd(moderatorRates, {
              input: moderatorInput,
              output: moderatorOutput,
            })
          : 0);
  return {
    calls: calls + moderatorCalls,
    inputTokens: inputTokens + moderatorInput,
    outputTokens: outputTokens + moderatorOutput,
    usd: cost,
    budgetUsd,
    overBudget: cost !== null && cost > budgetUsd,
  };
}
