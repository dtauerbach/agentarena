# Large batches, low and slow

How to generate a corpus of games in the background without exhausting a
subscription's usage window, and how to read it afterwards.

## Launch (detached)

A batch runs in its own tmux window, independent of the web app and of
Claude Code. It survives both being restarted.

```bash
tmux new-window -d -t main -n batch \
  "cd ~/code/agentarena && npm run sim -- batch experiments/mafia/baseline_mid.yaml \
   --n 100 --gap 300 --label baseline-mid-100 2>&1 | tee -a runs/baseline-mid-100.log"
```

- `--gap SEC`: wall-clock pause after each game. A game takes 8 to 10
  minutes at about 100 calls; with `--gap 300`, 100 games take about a day.
- `--abort-after K` (default 5 for live providers): when K model calls in a
  row fail (usage limit reached, CLI logged out), the game is cut short and
  marked aborted. The runner waits 15 minutes, then 30, 60, up to 2 hours,
  and replays the same seed. After 8 aborted attempts on one seed the batch
  halts. Aborted attempts stay on disk and are never counted.
- Live games run one at a time. In-game calls still run up to
  `concurrency` (5) at once.

Watch it: `tmux select-window -t main:batch`, or open the batch page in the
web app (`/lab`), which shows results so far and the runner's log.

## Resume

The directory is the state. A seed is done when one of its run dirs holds a
completed game. After a sandbox recreate, a crash, or a halt:

```bash
npm run sim -- resume runs/batch-<timestamp>-baseline-mid-100
```

## What a game's record holds

Everything an offline reader needs is in the run directory:

| File | Holds |
|---|---|
| `config.resolved.json` | every prompt, the seat deal (`model.per_agent`), `roles`, outcome patterns, seed, git hash |
| `board.jsonl` | each post: room, clock, author, the post as shown, and the raw reply including private reasoning |
| `events.jsonl` | announcements, eliminations, rooms opening and closing, referee notes, tallies, errors, the run's end |
| `calls.jsonl` | every request and raw response with server ids, tokens, latency |

`analyze` derives from those, per batch:

- `batch.csv`: one row per game with `outcome`, `outcome_t`, `eliminated`,
  tokens, and the conversation metrics.
- `batch_agents.csv`: one row per seat with `role`, `provider`, `model`,
  `won`, `survived`, `eliminated_at`.
- `batch_summary.json`: outcome counts and win and survival rates by model
  and role.

The winner is never decided by the harness. The referee model announces it;
analysis recognizes the announcement with the patterns in
`metrics.outcomes`. A game with no matching announcement has outcome `none`.

## Seat deals

`model.lineup` lists a pool of models with counts. Each game deals the pool
onto the seats with a shuffle seeded by the game's seed, so across a batch a
model is not tied to a name or a role. The deal is written into the resolved
config. Over 100 seeds each seat draws each model in proportion to its count.

## Read it (the observer)

```bash
npm run sim -- analyze runs/batch-<...> --observe observers/baseline.yaml --yes
```

`observers/baseline.yaml` reads in two stages, because 100 transcripts do not
fit one context:

1. One note per game (Sonnet), from the full record including the roster and
   every player's private reasoning. Notes are cached as
   `observer-note.baseline.json` in each run dir, with a pause between calls,
   so an interrupted pass resumes where it stopped.
2. One synthesis (Opus) over the batch statistics and the notes. Written to
   `observer.json`, shown on the batch page and in Discover.

## Cost

Subscription runs have no dollar cost, but they draw on the usage window.
The batch page and `batch_summary.json` report calls and tokens so far.
Dollar-equivalent estimates need a row per model in
`experiments/pricing.yaml`; the GPT models have none yet.
