# Codex provider: ChatGPT-subscription agents

The `codex` provider runs each agent turn as one `codex exec` call, billed to
a ChatGPT subscription (Plus/Pro) instead of OpenAI API credits. It is the
OpenAI counterpart of `claude_code`. Mix freely: GPT players among Claude
players, a GPT referee for a Claude game, and so on.

## One-time setup (the only part that needs you)

Codex runs inside the sandbox; nothing is installed on the host. The CLI is a
dev dependency of this project (`node_modules/.bin/codex`) and its
credentials live in `.sandbox/codex-home/` (gitignored, survives
`sandbox --recreate`).

1. In the sandbox (ask Claude, or type it after `!` in the prompt):

   ```bash
   CODEX_HOME=.sandbox/codex-home npx codex login --device-auth
   ```

2. It prints a URL and a one-time code (valid 15 minutes). On any device,
   open `https://auth.openai.com/codex/device`, sign in with the ChatGPT
   account that has the subscription, and enter the code.
3. Check: `CODEX_HOME=.sandbox/codex-home npx codex login status`.

If the device page says device codes are disabled: in ChatGPT, Settings →
Security, enable device code authorization for Codex, then repeat.

Fallback (browser login on the host, then hand the token to the sandbox):

```bash
npx @openai/codex login
mkdir -p ~/code/agentarena/.sandbox/codex-home
cp ~/.codex/auth.json ~/code/agentarena/.sandbox/codex-home/auth.json
```

To log out: `CODEX_HOME=.sandbox/codex-home npx codex logout`.

## Using it

- Launch form: provider `codex (your ChatGPT subscription)` for the whole
  run, or per player / moderator under "ChatGPT subscription via Codex".
  The model list comes from the CLI's own catalog (`codex debug models`).
- YAML: `model.provider: codex`, or `model.per_agent.<name>: { provider:
  codex, name: <model> }`, or `moderator.provider: codex`.
- `model.effort` maps to Codex's reasoning effort. `model.thinking`,
  `temperature`, and `max_tokens` have no Codex equivalent and are ignored;
  `output.max_words` still applies through the prompt.
- No dollar estimate is shown for models without a row in
  `experiments/pricing.yaml`; add a row if you want the API-equivalent cost.

## What the agent sees (purity)

Measured live on 2026-09-29 with codex-cli 0.159.0, not assumed.

- **System prompt: the experiment's own.** It is passed as
  `model_instructions_file`, which replaces Codex's base instructions (a
  coding-agent preamble of 17-21K characters). The session record confirms
  it: `base_instructions.provenance = custom`. Before the replacement a
  probe answered "I am Codex, a collaborative AI coding assistant"; after,
  it does not.
- **Input: the wake prompt only.** `codex debug prompt-input` shows no
  environment block, skills list, plugin/app/permission instructions, or
  project docs (AGENTS.md). The working directory is an empty scratch dir,
  so nothing from this repository can leak in.
- **Known impurity, disclosed:** about 1,750 input tokens of built-in tool
  definitions that the CLI always attaches (`exec`, `wait`,
  `request_user_input`), constant across agents, wakes and conditions. No
  feature flag removes them. The sandbox is read-only and the directory
  empty, so a tool call can do nothing, but an agent can see that tools
  exist. For a contamination-free GPT agent use the `openai` provider with
  an API key.
- `temperature` and `max_tokens` are not controllable.

## Audit trail

Each call's raw record in `calls.jsonl` carries the Codex thread id, the
usage block, and the full JSONL event stream. Sessions persist under
`.sandbox/codex-home/sessions` unless `ARENA_EPHEMERAL_SESSIONS=1`.
