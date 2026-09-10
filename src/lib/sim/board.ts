import type { Config } from "./config";

export type BoardPost = {
  id: number;
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
    id: post.id,
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

// Blocks are chunked by absolute post id so a given block's bytes never change
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
    const slot = Math.floor((post.id - 1) / size);
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
