# Protocol: Agent Pair Unique Enemies Killed, clean series

**Agent Pair Unique Enemies Killed** is this benchmark's internal name (the results page is titled "Agent Pair
Scaping"). How to run and publish the benchmark on the results page (`docs/index.html`) so that a new run is
comparable with the existing ones. The **clean series** is every run from **r047** on with the label
`<model>-clean`. Nothing listed under "Fixed conditions" may change within the series. A change there
starts a new series, with its own name and run range, and existing results are never mixed with it.

Run labels so far: `ds-clean` (DeepSeek V4.1 Flash), `sol-clean` (GPT-6.1 Sol), `qwen-clean`,
`haiku-clean`, `glm-flash-clean`, `hy4-clean` (HY4 Preview), `kimi-clean` (Kimi K3), `kimi31-pro-clean`
(Kimi K3.1 Pro, one run only: r076),
`terra-clean` (GPT-6.1 Terra, through OpenAI's API: see below).

## Fixed conditions

**Game**
- rs-sdk at commit `55fa26ccaad35417c4fe828000e5d832512186c1` plus `patches/rs-sdk.patch`, set up as in
  `patches/README.md`. The patch contents are listed under "Local patches to rs-sdk" in `bench/README.md`.
- Engine started exactly as in `bench/README.md`, "Start the engine":
  - 8× speed (`NODE_TICKRATE=50`);
  - friend server on, so PMs work;
  - chat filter off;
  - no live reload;
  - kill ledger at `ledger/kill_ledger.jsonl`.
- Random events off (the default). The server's 25× XP rate is not disclosed to agents.

**Team and task**
- 2 agents, always named Alpha and Bravo.
- 15 minutes of real time.
- Unique-enemies scoring: `score = Σ ln(1 + highest level killed)` over distinct NPC names, via `scoreUnique` in
  `bench/score.ts`.
- Every account is fresh (combat 3). `run.ts` refuses to start otherwise.
- `run.ts` starts a fresh gateway for every run.

**Prompt**
- `uniquePrompt()` in `bench/run.ts`, in its r047 form, with the scoring examples given as bare levels.
- No `--strategy` file, no strategy hints, no kill reporting or scoreboard.

**Harness**
- OpenCode **1.19.3** (`opencode --version`). Never let it auto-update mid-series.
- One OpenCode config per model in `bench/opencode.<model>.json`. Copy an existing one for a new model.
  Everything except the model block stays as it is:
  - `"timeout": 180000`;
  - `experimental.mcp_timeout: 300000`;
  - the `external_directory` deny;
  - the bash deny list;
  - the key as `{file:~/.runebench/openrouter.key}`.
- All models go through OpenRouter, at the model's **default reasoning effort**: set no `reasoning` or
  effort option.
- Exception: GPT-6.1 Terra (r087–r089) went through OpenAI's API (`opencode.gpt-terra.json`, key in
  `~/.runebench/openai.key`), since it wasn't on OpenRouter yet. Its cost is token counts at OpenRouter's
  list price for it, within 1% of OpenAI's charge for r087.

**Host routing**
- Open-weight models are pinned to `"quantizations": ["fp8", "bf16"]` with `"require_parameters": true`.
- Exception: when the model's own first-party host serves a lower format, allow that format too, so the
  first party is a candidate. Kimi K3 allows `["mxfp4", "fp8", "bf16"]`, because Moonshot serves mxfp4.
- Priority or "highspeed" endpoints are excluded: a faster endpoint scores better in a timed bench. Pin the
  standard endpoint by its tag with `"only"` (Kimi K3.1 Pro: `"only": ["moonshotai/mxfp4"]`).
- Closed models (OpenAI, Anthropic, Google) are not pinned.
- New models not yet known to OpenCode also get a `"limit": {"context": ..., "output": 32768}` block.
- Before the first run, list the hosts and record which ones the pin allows:
  `curl -s https://openrouter.ai/api/v1/models/<id>/endpoints`.

## Adding a model

1. Write `bench/opencode.<model>.json`, following the rules above.
2. Add it to `OPENCODE_CONFIGS` in `bench/run.ts`.
3. Add a `PRICING` entry in `bench/pricing.ts`, in $ per token, with a comment giving the host price range.
   - If the first party is among the allowed hosts, use its list price.
   - Otherwise use the dearest allowed host, so the budget cap errs high.
   - GLM-5.3 Flash uses Z.AI's list price, as GLM-5.3 does.
4. Smoke-check through run 1 itself; a separate smoke run would use up a run number. Within the first two
   minutes:
   - both transcripts (`agent-*.jsonl`) have `step_finish` events;
   - `rs-agent_execute_code` tool calls complete;
   - cache reads appear in the tokens;
   - there are no `"type":"error"` events.

   Abort and fix the config if any of these fail.

## Running a series (three runs)

Before each run:
- The engine is up: `http://localhost:8888` answers.
- No gateway is on port 7780, and no other run is in flight. Runs always go one at a time, since two runs
  would share the bot names.

Each run, from `E:\runebench`:

```sh
bun bench/run.ts --agents 2 --minutes 15 --mode unique --model openrouter/<id> --record --budget <usd> --label <slug>-clean
```

- `--budget` is a safety cap and must not bind:
  - set it comfortably above the expected cost: $1 for cheap models, $3–5 for Sol- or Kimi-priced ones;
  - if the estimate approaches the cap, raise it for the next run;
  - `run.ts` also refuses to start if the account or key has less credit than the budget.
- Open the live view (`runs/<run>/live.html`) with `Start-Process`.
- Run the three runs back to back.

After each run, check `runs/<run>/orchestrator.log` (or the captured stdout):
- the `SCORE` line;
- relaunches (`launch #2`): normal near the deadline, suspicious early on;
- `BUDGET reached`;
- `OUT OF CREDITS`;
- API errors in the transcripts (`grep '"type":"error"' runs/<run>/agent-*.jsonl`). A `The operation timed out.`
  error is a provider stall past the 3-minute timeout; record it in the run notes.

Record actual spend, too. Read the key's `usage` before and after each run:

```sh
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $(cat ~/.runebench/openrouter.key)"
```

Print only the usage numbers, never the key. So far only Kimi K3's actual charges are known.

## Valid runs

A run is **excluded** (but kept in `runs/`) when any of these happened:
- OpenRouter ran out of credit during it: `results.json` has `invalid`. r051 and r052 are suffixed
  `-NOCREDITS`; r050 lost its model 8 minutes in for the same reason and is excluded too.
- An agent lost its game tool (r042, before the MCP fix).
- The budget cap stopped it well before the deadline.

A cap or relaunch in the last seconds is kept, with a note: r073 was capped 14 s early.

Excluded runs are rerun under the same conditions, and the page says which runs were excluded and why.

## Numbers for the results page

- **Score, enemy types, kills:** from `results.json`. To rescore a run, use `bun bench/score.ts runs/<run>`.
- **Mean and ±:** the mean of the three runs and the sample standard deviation.
- **Cost:** `costUsd` in `results.json`, which is the token counts × `PRICING`. The exception is a model
  whose costs are actual charges (Kimi K3), which the note under the table says.
- **Deaths:** `python -I bench/deaths.py runs/<a> runs/<b> runs/<c>`, giving Alpha + Bravo per run.
- **Per-agent kills:** the ledger lines in `runs/<run>/kills.jsonl` (`killer`). Use these to check run-note
  claims, for example against `final-state/team/notes.md`.

## Timelapse

```sh
python -I bench/map-timelapse-multi.py --zoom 3 --out runs/compare/<slug>-clean-zoom --title "<Model> · 3 runs" runs/<a> runs/<b> runs/<c>
ffmpeg -y -loglevel error -i runs/compare/<slug>-clean-zoom/map-timelapse.mp4 -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p -movflags +faststart runs/compare/<slug>-clean-zoom/map-timelapse-web.mp4
cp runs/compare/<slug>-clean-zoom/map-timelapse-web.mp4 docs/media/<slug>-timelapse.mp4
ffmpeg -y -loglevel error -sseof -0.5 -i runs/compare/<slug>-clean-zoom/map-timelapse.mp4 -frames:v 1 -q:v 4 docs/media/<slug>-poster.jpg
```

The engine must be up, because the map base is rendered from it.

## Updating the page (`docs/index.html`)

Models appear in order of mean score everywhere: tabs, legend, summary table, all-runs table.

1. **Timelapse tab and panel:** video, poster and a one-line caption saying where the teams went. Then the
   run notes: specific, checked against the ledger and transcripts, in past tense.
2. **Chart** (`#main-chart`):
   - add a `RUNS` entry with exact costs to 4 decimal places;
   - add `COLOR`, a label offset in `off`, a legend `<span data-m>`, and the model name in the SVG's
     `aria-label`;
   - widen the x range if a cost falls outside it.
3. **Colour:**
   - a new `--m-<slug>` token, with a dark-mode value in both dark blocks;
   - validate the full palette with the dataviz skill's validator, `--pairs all`: `--mode light --surface
     "#ffffff"`, then `--mode dark --surface "#1b1f24"`;
   - seven colours is the limit. A newer model of a family already on the chart reuses the family's colour with a
     diamond marker (`DIAMOND` in the chart code, `class="diamond"` on its legend and table dots), as Kimi K3.1 Pro
     does beside Kimi K3. Otherwise an eighth model needs a redesign.
   - a model with fewer than three runs says so in its run notes (`n = 1`), its legend entry, the chart caption
     and the table note, and shows no ±.
4. **Tables:** a row in the summary table (mean score ± sd, the three run scores, cost, enemy types, deaths per
   run) and three rows in the "all runs" table.
5. **Text:**
   - the score range in Limitations;
   - one comparative sentence in the results paragraph;
   - the cost note, if the model's costs aren't priced the usual way.
6. **Check:** look at screenshots of the chart and tables in light mode, dark mode and at 375 px wide, and make
   sure there are no console errors.

## Accounts

`run.ts` archives each bot's save and bot folder into `runs/<run>/final-state/` at teardown. Leftovers from a crashed
run go to `runs/orphaned/`.

To reset an account by hand (for example a human-baseline account):
1. Wait until it is offline in `/playerpositions`.
2. Move `rs-sdk/server/engine/data/players/main/<name>.sav` and its bots folder out.
3. Archive and delete its row in `rs-sdk/server/engine/data/market.sqlite` (table `accounts`, owner
   lowercase). Check `offers` too.

## Variant: soloagentdualboxuniquekills

**soloagentdualboxuniquekills** is the same bench with **one agent controlling both characters** instead of
one agent each. Everything under "Fixed conditions" applies unchanged except the team and the prompt:

- **Team:** one OpenCode session (`Solo`, transcripts `agent-Solo-<n>.jsonl`) drives Alpha and Bravo through one
  MCP server, choosing the bot per `execute_code` call. Calls to different bots run at the same time, and
  the agent's next turn waits for all of them.
- **Prompt:** `soloPrompt()` in `bench/run.ts`. It is `uniquePrompt()` line for line, changed only where the
  pair wording would mislead: plural bots, "both controlled by you", and no shared notes file or chat line,
  since there is no one to coordinate with. It doesn't explain how parallel calls behave; don't add hints.
- **Run labels:** `<slug>-solo2`, using the same slugs as the clean series. Never mix these runs into the
  clean series' tables or means.
- **Models:** only models with three clean-series runs, with their unchanged OpenCode config and routing, so
  each model has a pair-vs-solo comparison. Three runs each.

```sh
bun bench/run.ts --agents 1 --characters 2 --minutes 15 --mode unique --model openrouter/<id> --record --budget <usd> --label <slug>-solo2
```

A solo run costs about 40–50% of a pair run (Sol ~$0.65), so `--budget` can be set from the solo costs: Sol
solo used $1.50 (r082–r083; r081 used $3). Valid runs, numbers, deaths and timelapses work as in the clean series. A stalled or timed-out request
idles both characters; that is part of the condition, not grounds for exclusion. `results.json` has
`characters: 2` and `agents: ["Solo"]`, and its per-agent cost and timing cover both characters.

r077 (`smoke-solo3`, 3 characters, 4 minutes) was the harness smoke test and belongs to no series.

## Never

- Print the OpenRouter key, put it under `E:\runebench`, or put it in agent environment variables.
- Run two runs at once.
- Change a fixed condition mid-series.
- Delete run data. Move or rename it instead.
