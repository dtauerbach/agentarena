import type { BoardPost } from "./board";
import { fill, renderBoardBlocks, renderClock } from "./board";
import type { Config } from "./config";
import type { Preference } from "./parse";

// per-(agent, room) attention state; an agent in two rooms checks each
// independently, like two boards open in two tabs
export type RoomAgentState = {
  hasWoken: boolean;
  lastSeenSeq: number;
  nextWakeTime: number;
  wakeVersion: number;
  preference: Preference;
};

export type AgentState = {
  name: string;
  privatePrompt: string | undefined;
  injections: { t: number; text: string }[];
  muted: boolean;
  composing: boolean;
  rooms: Map<string, RoomAgentState>;
};

export function makeAgentState(config: Config, name: string): AgentState {
  return {
    name,
    privatePrompt: config.private_prompts[name],
    injections: [],
    muted: false,
    composing: false,
    rooms: new Map(),
  };
}

export function makeRoomState(): RoomAgentState {
  return {
    hasWoken: false,
    lastSeenSeq: 0,
    nextWakeTime: 0,
    wakeVersion: 0,
    preference: "later",
  };
}

// SPEC §4: exactly one of the three status lines closes the private block
function statusLine(
  config: Config,
  roomState: RoomAgentState,
  posts: readonly BoardPost[],
): string {
  if (!roomState.hasWoken) return config.render.first_wake_line;
  const firstNew = posts.find((p) => p.seq > roomState.lastSeenSeq);
  if (firstNew) return fill(config.render.new_since_line, { id: firstNew.seq });
  return config.render.nothing_new_line;
}

export function renderPrivateBlock(
  config: Config,
  agent: AgentState,
  roomState: RoomAgentState,
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
  lines.push(statusLine(config, roomState, posts));
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

export type RoomInfo = {
  name: string;
  prompt?: string;
  // boards of other rooms this room can read, in config order
  views?: { name: string; posts: readonly BoardPost[] }[];
};

// the read-only boards of viewed rooms, each under its header
export function renderViewBlocks(
  config: Config,
  agent: AgentState,
  views: RoomInfo["views"],
): string[] {
  const header = config.render.view_header;
  if (views === undefined || header === undefined) return [];
  return views.map(
    (view) =>
      `${fill(header, { room: view.name })}\n${renderBoardBlocks(config, view.posts, agent.name).join("\n")}`,
  );
}

// the user-message content blocks of a wake (or gate/revise) call, in SPEC §4
// order; a room with a prompt gets it as the leading block (stable, cacheable),
// then any viewed boards, then the room's own board
export function buildWakeBlocks(
  config: Config,
  agent: AgentState,
  room: RoomInfo,
  roomState: RoomAgentState,
  posts: readonly BoardPost[],
  instruction: string,
): string[] {
  return [
    ...(room.prompt !== undefined
      ? [fill(room.prompt, { room: room.name })]
      : []),
    ...renderViewBlocks(config, agent, room.views),
    ...renderBoardBlocks(config, posts, agent.name),
    renderPrivateBlock(config, agent, roomState, posts),
    instructionBlock(config, instruction),
  ];
}
