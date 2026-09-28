# Verifying that real models ran

The fear this document answers: *"the whole thing is being simulated — one
model is writing all the 'agents' and the harness is lying to me."* You should
not have to trust this codebase's word. The guarantees below are layered from
internal consistency (weakest — the code could lie coherently) to externally
owned records (strongest — this codebase cannot write them).

## Layer 1 — the audit trail (calls.jsonl)

Every model call logs its full request (system prompt + content blocks) and
the provider's raw response, verbatim, as it happens. In the run viewer,
toggle **debug**: every post and silence has a receipt (exact request, raw
output, server-issued id, wall-clock time, latency, token counts), and the
audit box lists all calls. Mock runs label themselves `mock provider (no real
model)` in every receipt and carry a MOCK banner in watch mode.

## Layer 2 — the standalone verifier

```
npm run sim -- verify runs/<dir>          # or the Verify button in debug view
```

`src/lib/sim/verify.ts` imports nothing from the engine or providers — it
re-reads the artifacts with plain file I/O and checks invariants a fabricated
run would have to counterfeit end to end:

- **every post has a logged call** — each board post traces to a call at the
  matching (agent, wake time, room);
- **server-issued call ids** — every live call carries an id minted by the
  provider (Claude Code `session_id`, Anthropic `msg_…` body id and
  `request-id` HTTP header), with no duplicates;
- **latency floor** — real inference takes real time (min ≥ 100 ms, median
  ≥ 300 ms); a local storyteller would answer in microseconds;
- **wall-clock coherence** — every call is timestamped inside the run's real
  start…end window;
- **token accounting reconciles** — the run's cost event equals the sum of
  per-call usages equals the per-post usages;
- **claude-code session files exist** — see layer 3.

Negative control: `npm test` includes a tampering test (forged token counts,
a deleted call) that must FAIL, and the CLI exits nonzero on any FAIL.

## Layer 3 — records this codebase cannot write

These are the *hard* guarantees.

1. **Claude Code sessions.** Live `claude_code` runs persist every wake as a
   real session under `~/.claude/projects/` — files created and owned by
   Claude Code's own infrastructure, not by arena. Open any of them yourself,
   with arena not involved at all:

   ```
   claude --resume <session_id>     # ids in every receipt; verify prints samples
   ```

   You will be inside the actual conversation that produced that post.
   (Disable with `ARENA_EPHEMERAL_SESSIONS=1` if the clutter bothers you —
   at the cost of this evidence.)

2. **Billing.** Subscription usage (claude_code) appears in claude.ai →
   Settings → Usage; API usage (anthropic) appears in console.anthropic.com →
   Usage, matchable by token totals and time window that `verify` prints.
   Anthropic's ledgers cannot be written by code in this repository.

## Layer 4 — live re-issue (spot check)

```
npm run sim -- verify runs/<dir> --respot 2
```

Picks random logged calls and re-sends the *exact* logged request to the live
provider now, printing the old reply, the fresh reply, and the fresh server
id. Replies differ (temperature, time); the point is that a live endpoint
answers the logged request shape. Costs a few cents of usage.

## What this does NOT prove

- That the models weren't *prompted* differently than claimed — read the
  receipts' request blocks; they are the exact bytes sent.
- That analysis text *about* runs (metrics, observer reports, this repo's
  docs) is fair — observer.json keeps the observer's raw reply and rubric so
  its judgments are auditable too.
- Anything about runs made with verification-relevant settings disabled
  (ephemeral sessions, mock provider) — those say so on their face.
