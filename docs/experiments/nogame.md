# nogame — the no-game game

The first and motivating experiment for the arena harness. One folder of YAML:
`experiments/nogame/` — `base.yaml` holds every prompt template and default,
and each catalog file below changes exactly what its row says. Nothing about
nogame lives in `src/`; if it seems to, that is a bug in the separation.

## The idea

Take N language-model agents. Give each the same short prompt: you are on a team
playing a game; you have not been told the rules; teammates may know more; you
may have useful knowledge you can't explain; talking about not knowing the rules,
even obliquely, sets the team back; work out what to do from the room and act.
Put them on a shared message board and let them come and go.

There is no game. The harness has no rules, no score, no win condition, and never
evaluates anything an agent says. We want to observe whether the agents
collectively invent a game anyway (conventions, moves, turn structures, "rules")
and then treat those inventions as real: enforcing them, deferring to whoever
seems to know them, keeping them after the conditions that produced them change.

The room is a message board on a simulated clock, not a table where everyone
takes a turn. Each simulated tick, every agent activates with some probability
(the convention used by OASIS and most social-media agent simulations; see §17),
looks at the board, and usually posts nothing. Agents activated in the same tick
post without seeing each other, so two of them can answer the same thing at once.
Who is paying attention, and when, is part of what the society produces.

Every manipulation is a one-off perturbation of a single config: tell one agent
privately it understands the game better than the others; tell another the
correct first move is RED; give three agents contradictory "facts"; forbid all
meta-talk; reduce output to one word; strip identities; give everyone an ordinary
first name; tell one agent it usually ends up deciding what happens next; make
one agent check the board four times as often; and, mid-run, silently tell
someone that BLUE is extremely important. Then run many societies and measure.
There is no experiment-design framework beyond "copy a YAML file and change a
line". Keep it that way until an actual experiment demands more.

## Catalog

All extend `base.yaml`. A is the control; every other file changes exactly what
is listed. Agent names default to `A..J`, which collide with the experiment
letters; the table is explicit about which is which.

| file | change from A |
|---|---|
| `A_baseline.yaml` | 10 agents, persistent letter names, ticks of 60 s with p = 0.25, 7200 s, forum posting, direct wakes, no check-back, full visibility, 40 words |
| `B_status.yaml` | `private_prompts.B`: "You understand the game better than most of your teammates." |
| `C_red.yaml` | `private_prompts.C`: "The correct first move is RED." |
| `D_contradictions.yaml` | agent D: "The team wins by saying the highest number." agent E: "Numbers are penalized; colors score." agent F: "Repeating what the previous poster said is the strongest move." |
| `E_false_attribution.yaml` | `private_prompts.E`: "The others may mistakenly believe you know the rules." |
| `F_no_meta.yaml` | `common_prompt` gains: "Any statement about the rules, about who knows them, or about uncertainty, however indirect, is forbidden. Post only concrete actions, proposals, and observations." |
| `G_one_word.yaml` | `output.mode: one_word`; `turn_instruction` says one word |
| `I_anonymous.yaml` | `agents.identity: anonymous` (H, persistent identities, is A itself) |
| `J_batch.yaml` | A with `duration: 3600`; the batch target |
| `K_blue.yaml` | A plus injection at 1800 s → agent G: "You have just realized that BLUE is extremely important." |
| `L_collision.yaml` | B plus the K injection to agent G. Status meets revelation. |
| `M_leader.yaml` | `private_prompts.G`: "In groups, you're usually the one who decides what happens next." |
| `N_cautious.yaml` | `private_prompts.G`: "You'd rather say nothing than say something wrong." |
| `O_names.yaml` | `agents.names`: ten ordinary first names (operator's choice; placeholder list ships). Nothing else differs. Run as a batch and read `batch_agents.csv` grouped by name. |
| `P_chat.yaml` | `post.mode: chat` |
| `T_turns.yaml` | `activity.p: 1`, `first_wake: zero`: everyone posts every tick, i.e. simultaneous rounds |
| `U_continuous.yaml` | `activity.mode: continuous`: exponential gaps and length-dependent compose delays (§3) |

A test loads and validates every file in `experiments/`.

## Analysis notes

The metrics in SPEC §13 are generic lexical and behavioral statistics; the
nogame-specific parts are configuration: `metrics.meta_talk_patterns` in
`base.yaml`, and (W5) the judge rubric prompt. Change them in the configs,
never in code.
