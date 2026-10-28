# arena — start here

Read `CLAUDE.md` first: it is the project brief and carries the hard rules that
protect the experiments. Then `docs/SPEC.md` (design) and `PROGRESS.md`
(current status, decisions, changelog). `README.md` is the short tour.

Non-negotiables, spelled out in `CLAUDE.md`:

- The harness never adjudicates: no score, rule engine, or game master in code.
- Every string an agent reads lives in `experiments/<name>/*.yaml`, never in `.ts`.
- Log raw model output; never retry or clean a response because it is "bad".
- `npm run check` must pass before anything is called finished.
- No live API calls in tests; the `mock` provider is free and deterministic.
- Keep `PROGRESS.md` current as `CLAUDE.md` describes; commit at every green state.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
