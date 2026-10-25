# Combat benchmark harness

The benchmark on the results page is unique-enemies mode (`--mode unique`, below), in the clean
series (r047 on). [`PROTOCOL.md`](PROTOCOL.md) has the exact conditions, how to add a model and run a series,
and how results reach the page. Kills come from the engine's kill ledger (credit = highest damage
dealer, the engine's own loot rule), tailed live into `runs/<run>/kills.jsonl`.

### Unique-enemies mode (`--mode unique`)

Score = sum over every distinct enemy the team killed of ln(1 + combat level). An enemy is its
in-game name (the ledger's `man`, `man2`, `man3` are all "Man"; names come from the content `.npc`
configs via `npc-names.ts`), valued at the highest level of it killed, so Goblin 2 and Goblin 5
are one enemy worth ln 6. The log keeps breadth meaningful (Lesser demon 82 = 4.42, Chicken 1 = 0.69).
Repeat kills add nothing but aren't penalised (training is legitimate). Results also report the
plain level sum, distinct enemies per agent, overlap (enemies more than one agent killed),
non-scoring kills, and when the final score was reached (tiebreak). Agents get no tally; tracking
what the team has killed is part of the task. Random events must stay off (`NODE_RANDOM_EVENTS`,
default false): their monsters scale to the player and would be free uniques.

### Strongest mode (`--mode strongest`, the default; runs before r019)

Kill value = combat level × HP / (HP + seconds to kill), i.e. combat level scaled by DPS
against that NPC (1 HP/s keeps 50%). Score = best NPC type, where a type is worth the mean
of the team's 3 best kills of it (missing kills count 0), so one lucky kill is worth a third. Time is in game
seconds (0.6s/tick), so it doesn't depend on server speed. Tunables live in `score.ts`.

## Start the engine (leave running)

```sh
# 8x speed (same as rs-bench) + kill ledger, chat filter off, no live reload
# (dev-mode live reload repacks the game on content-file access on Windows, mid-run),
# and the friend server, which private messages go through (without it the engine drops
# every PM while sdk.dm() still reports success; from r042, earlier runs had no PMs)
cd rs-sdk/server/engine
NODE_TICKRATE=50 NODE_PROFANITY_FILTER=false BUILD_LIVE_RELOAD=false EASY_STARTUP=true FRIEND_SERVER=true KILL_LEDGER_FILE=E:/runebench/ledger/kill_ledger.jsonl bun run quickstart
```

PowerShell equivalent:
`$env:NODE_TICKRATE=50; $env:NODE_PROFANITY_FILTER='false'; $env:BUILD_LIVE_RELOAD='false'; $env:EASY_STARTUP='true'; $env:FRIEND_SERVER='true'; $env:KILL_LEDGER_FILE='E:/runebench/ledger/kill_ledger.jsonl'; bun run quickstart`

Don't start a gateway: `run.ts` starts a fresh one per run (and refuses to run if one is already
on 7780). The gateway keeps each bot name's chat in memory, and names repeat every run.

## Run

Put the OpenRouter key (just the key, nothing else) in `%USERPROFILE%\.runebench\openrouter.key`.
Keep it out of `E:\runebench` and out of env vars: agents have a shell and will read anything
they can reach. Give the key a credit limit on OpenRouter; that is the real backstop.
OpenCode is configured to deny paths outside `rs-sdk`. Then from `E:\runebench`:

```sh
bun bench/run.ts --agents 1 --minutes 30            # DeepSeek V4.1 Flash via OpenCode
bun bench/run.ts --agents 3 --minutes 30
bun bench/run.ts --agents 2 --minutes 30 --mode unique --record   # distinct-enemies benchmark
bun bench/run.ts --agents 1 --minutes 5 --record    # browser client + screenshots, live.html, timelapse mp4
bun bench/run.ts --agents 1 --minutes 4 --backend claude --model haiku --label smoke
bun bench/score.ts runs/<runDir>                    # rescore a finished run
bun bench/run.ts --agents 1 --characters 2 --minutes 15 --mode unique --record   # one agent ("Solo") drives Alpha and Bravo
```

`--characters N` gives a single agent N characters through one MCP server (unique mode only); see
"Variant: soloagentdualboxuniquekills" in [`PROTOCOL.md`](PROTOCOL.md).

`--strategy <file>` appends a human-written plan to every agent's prompt and copies it into the run
dir as `strategy.txt`. To make one on the world map, run `bun bench/strategy-editor/server.ts` and open
http://localhost:7790: click the map to place tasks (per agent, in order), search the wiki's NPC spawns,
and save to `strategies/<name>.txt` (plus `.json` for re-editing). The map is a static render
of the whole surface (`bun bench/map-base.ts bench/strategy-editor 3900 3400`, framed by that folder's
`positions.jsonl`: x 2100–3600, z 2700–3985), so
the engine doesn't need to be up.

Bots are always named Alpha, Bravo, Charlie, ... At teardown each bot's save
(`server/engine/data/players/main/<name>.sav`), its `bots/<name>/` folder and `bots/_team/`
are moved into `runs/<run>/final-state/`, so the next run starts from fresh accounts
(setup refuses to start unless every bot is combat level 3). Leftovers from a crashed run go to
`runs/orphaned/`. One run at a time: two concurrent runs would share the names.

Each run writes `results.json`, `kills.jsonl`, per-agent transcripts, and `orchestrator.log`
to `runs/<date>-r<NNN>-...`. `results.json` includes `timing` (from `timing.ts`): per agent,
seconds spent waiting on the model vs running tools, median model seconds per turn, and game
calls per minute. `bun bench/timing.ts runs/<run> [--write]` computes it for older runs
(r019–r045 are backfilled).

## Local patches to rs-sdk

- Dialogue text (from r019; earlier runs didn't have it): the world-state summary after each
  `execute_code` now shows the open dialog's text (speaker and speech, not just its options) and a
  `## Recent Dialogue` section with pages seen since the last call, including ones an action
  clicked through or closed. `sdk.getDialog().text` is filled in. The clients' dialogue history
  skipped any page on the same interface as the last captured one, so back-to-back NPC lines of
  the same length were dropped (verified on the live server); it now dedupes by content and
  resets when the dialog closes (`Client.ts`, `lite/actions.ts`,
  `bot/StateCollector.ts`, `sdk/formatter.ts`, `mcp/execute-code.ts`). After editing the client,
  rebuild it (`cd server/webclient && bun run build`) and restart the engine.

- No level-up dialogue (from r042; r041 was the smoke test, earlier runs had it): `content/scripts/levelup/scripts/levelup.rs2`
  no longer opens the "Congratulations" chat box or the unlock dialogues; the new level goes to the
  chatbox as a message. The box is a chat modal, and while one is open the engine skips the player's
  interactions (`Player.canAccess()`), so a level-up mid-fight stopped the attack until something
  clicked continue. At 25x XP that was every kill or two. `bot.*` actions only dismiss it before
  they start, not while an agent's own loop waits. Repack after editing content
  (`cd server/engine && bun run build`) and restart the engine; startup doesn't repack.
- Free Al Kharid toll gate (from r042): `content/scripts/areas/area_alkharid/scripts/border_gate.rs2`
  makes Open on either gate half pass straight through, with no border-guard dialogue and no 10gp
  toll. The dialogue stalled agents without testing anything the benchmark measures. `bot.walkTo`
  now routes through the gate by itself (tested both ways). Talking to the guards is unchanged.
- MCP server survives unhandled rejections (from r043): `mcp/server.ts` logs them instead of
  letting Bun exit. An un-awaited `sdk.say()` at the end of an `execute_code` call is cancelled
  when the call returns, and the rejection killed the MCP server; OpenCode doesn't restart it, so
  the agent had no game tool for the rest of the run (r042 Bravo, from minute 7; r042 is excluded
  from averages).
- `KillLedger.ts` / `NpcOps.ts`: ledger lines carry `combatLevel` and `maxHp`.
- `bots/create-bot.ts --local` silently fails on Windows (CRLF template), so
  `run.ts` writes `bot.env` itself.
