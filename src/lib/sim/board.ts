import type { Config } from "./config";

// `id` is the global landing sequence (log identity); `seq` numbers posts
// within their room and is what agents see as {id}, so one room's traffic
// never leaks into another room's numbering
export type BoardPost = {
  id: number;
  seq: number;
  room: string;
  t_land: number;
  agent: string;
  message: string;
};

export function renderClock(t: number): string {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

export function renderLine(
  config: Config,
  post: BoardPost,
  viewer: string,
): string {
  const vars = {
    id: post.seq,
    clock: renderClock(post.t_land),
    name: post.agent,
    message: post.message,
  };
  if (config.agents.identity === "anonymous") {
    if (post.agent === viewer && config.agents.mark_self)
      return fill(config.render.self_line, vars);
    return fill(config.render.anonymous_line, vars);
  }
  return fill(config.render.line, vars);
}

// Blocks are chunked by room sequence so a given block's bytes never change
// once full — that is what makes the shared prefix cacheable across agents.
export function renderBoardBlocks(
  config: Config,
  posts: readonly BoardPost[],
  viewer: string,
): string[] {
  const visible =
    config.board.visibility === "full"
      ? posts
      : posts.slice(-config.board.visibility.last_n);
  if (visible.length === 0) return [config.render.empty_board];
  const size = config.board.block_posts;
  const blocks: string[] = [];
  let currentSlot = -1;
  for (const post of visible) {
    const slot = Math.floor((post.seq - 1) / size);
    const line = renderLine(config, post, viewer);
    if (slot !== currentSlot) {
      blocks.push(line);
      currentSlot = slot;
    } else {
      blocks[blocks.length - 1] += `\n${line}`;
    }
  }
  return blocks;
}

// The moderator's omniscient view of one room: full visibility regardless of
// board.visibility, and its own line template — names stay visible even in
// anonymous identity, or the referee could not attribute a MUTE.
export function renderModeratorBoard(
  config: Config,
  moderator: { line: string },
  posts: readonly BoardPost[],
): string {
  if (posts.length === 0) return config.render.empty_board;
  return posts
    .map((post) =>
      fill(moderator.line, {
        id: post.seq,
        clock: renderClock(post.t_land),
        name: post.agent,
        message: post.message,
      }),
    )
    .join("\n");
}

// complete board blocks never change bytes again (chunked by room seq);
// a sliding last_n window or an empty board has no stable prefix
export function stableBoardBlockCount(
  config: Config,
  posts: readonly BoardPost[],
): number {
  if (config.board.visibility !== "full" || posts.length === 0) return 0;
  const lastSeq = (posts[posts.length - 1] as BoardPost).seq;
  return Math.floor(lastSeq / config.board.block_posts);
}
