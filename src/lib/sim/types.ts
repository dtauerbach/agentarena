export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ProviderRequest = {
  system: string;
  blocks: string[];
  // leading user blocks whose bytes are stable across calls (complete board
  // blocks); the provider may set a cache breakpoint after the last one
  cacheableBlocks: number;
  maxTokens: number;
  temperature: number;
};

export type ProviderResult = { text: string; usage: Usage; raw: unknown };

export type Provider = {
  complete(req: ProviderRequest): Promise<ProviderResult>;
};

// one line of board.jsonl; snake_case because these are the logged fields
export type PostRecord = {
  id: number;
  t_land: number;
  t_wake: number;
  agent: string;
  raw: string;
  message: string;
  words: number;
  stale_count: number;
  revised: boolean;
  revise_raw?: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  latency_ms: number;
};

export type EventRecord = { t: number; kind: string } & Record<string, unknown>;

export type CallRecord = {
  t: number;
  agent: string;
  kind: "wake" | "gate" | "revise";
  request: { system: string; blocks: string[] };
  response: { text: string; usage: Usage; raw?: unknown } | { error: string };
  latency_ms: number;
};

export type EngineHooks = {
  emit(event: EventRecord): void;
  post(post: PostRecord): void;
  call(call: CallRecord): void;
};
