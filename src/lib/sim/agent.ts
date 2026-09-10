import type { BoardPost } from "./board";
import { fill, renderBoardBlocks, renderClock } from "./board";
import type { Config } from "./config";

export type AgentState = {
  name: string;
  privatePrompt: string | undefined;
  injections: { t: number; text: string }[];
  hasWoken: boolean;
  lastSeenId: number;
  composing: boolean;
  preference: "soon" | "later" | "much_later";
  nextWakeTime: number;
  wakeVersion: number;
};

export function makeAgentState(config: Config, name: string): AgentState {
  return {
    name,
    privatePrompt: config.private_prompts[name],
    injections: [],
    hasWoken: false,
    lastSeenId: 0,
    composing: false,
    preference: "later",
    nextWakeTime: 0,
    wakeVersion: 0,
  };
}

// SPEC §4: exactly one of the three status lines closes the private block
function statusLine(
  config: Config,
  agent: AgentState,
  posts: readonly BoardPost[],
): string {
  if (!agent.hasWoken) return config.render.first_wake_line;
  const firstNew = posts.find((p) => p.id > agent.lastSeenId);
  if (firstNew) return fill(config.render.new_since_line, { id: firstNew.id });
  return config.render.nothing_new_line;
}

export function renderPrivateBlock(
  config: Config,
  agent: AgentState,
  posts: readonly BoardPost[],
): string {
  const lines: string[] = [config.render.private_header];
  if (config.agents.identity === "persistent")
    lines.push(fill(config.render.you_are_line, { name: agent.name }));
  if (agent.privatePrompt !== undefined) lines.push(agent.privatePrompt);
  for (const inj of agent.injections)
    lines.push(
      fill(config.render.injection_line, {
        clock: renderClock(inj.t),
        text: inj.text,
      }),
    );
  lines.push(statusLine(config, agent, posts));
  return lines.join("\n");
}

export function instructionBlock(config: Config, instruction: string): string {
  const main = fill(instruction, { max_words: config.output.max_words });
  if (
    config.activity.check_back &&
    instruction === config.render.turn_instruction
  )
    return `${main}\n${config.render.check_back_instruction}`;
  return main;
}

// the user-message content blocks of a wake (or gate) call, in SPEC §4 order
export function buildWakeBlocks(
  config: Config,
  agent: AgentState,
  posts: readonly BoardPost[],
  instruction: string,
): string[] {
  return [
    ...renderBoardBlocks(config, posts, agent.name),
    renderPrivateBlock(config, agent, posts),
    instructionBlock(config, instruction),
  ];
}
