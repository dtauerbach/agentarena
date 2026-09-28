// golden-angle hue spread so adjacent names (A, B, C… or Alice, Bob…) get
// distinct colors; shared by the viewer and the launch form
export function agentColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${Math.round((hash * 137.508) % 360)} 65% 45%)`;
}
