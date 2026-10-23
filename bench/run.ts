// Combat benchmark orchestrator.
//
//   bun bench/run.ts --agents 1 --minutes 30                 # DeepSeek V4.1 Flash via OpenCode
//   bun bench/run.ts --agents 3 --minutes 30
//   bun bench/run.ts --agents 1 --minutes 5 --backend claude --model haiku   # smoke test
//   bun bench/run.ts --agents 2 --minutes 30 --mode unique   # score distinct enemies killed instead
//
// Assumes the engine (with KILL_LEDGER_FILE) is already running; starts its own gateway per run.
// Each run: fresh bots -> identical start (tutorial skipped, Lumbridge) ->
// N agents in parallel until the deadline -> score from the engine kill ledger.

import { spawn, spawnSync, type Subprocess } from 'bun';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, readSync, fstatSync, closeSync, appendFileSync, renameSync, statSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parseLedger, scoreRun, scoreUnique, type Kill } from './score';
import { PRICING, stepCost } from './pricing';
import { runTiming } from './timing';

const ROOT = resolve(import.meta.dir, '..');
const RS_SDK = join(ROOT, 'rs-sdk');
const LEDGER = process.env.KILL_LEDGER_FILE || join(ROOT, 'ledger', 'kill_ledger.jsonl');
const OPENCODE_EXE = process.env.OPENCODE_EXE || join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');

// Per-model OpenCode config (provider routing differs: DeepSeek is pinned to fp8/bf16 hosts,
// which would filter out OpenAI's endpoints entirely).
const OPENCODE_CONFIGS: Record<string, string> = {
    'openrouter/deepseek/deepseek-v4.1-flash': 'opencode.deepseek.json',
    'openrouter/openai/gpt-6.1-sol': 'opencode.gpt-sol.json',
    'openrouter/meta/muse-glimmer-30b': 'opencode.muse-glimmer.json',
    'openrouter/qwen/qwen3.8-flash': 'opencode.qwen-flash.json',
    'openrouter/deepseek/deepseek-v4.1-flash-1017': 'opencode.deepseek-1017.json',
    'openrouter/anthropic/claude-sonnet-5.5': 'opencode.sonnet.json',
    'openrouter/z-ai/glm-5.3': 'opencode.glm.json',
    'openrouter/z-ai/glm-5.3-flash': 'opencode.glm-flash.json',
    'openrouter/moonshotai/kimi-k3': 'opencode.kimi-k3.json',
    'openrouter/moonshotai/kimi-k3.1-pro': 'opencode.kimi-k31-pro.json',
    'openrouter/anthropic/claude-haiku-5.5': 'opencode.haiku.json',
    'openrouter/anthropic/claude-opus-5.5': 'opencode.opus.json',
    'openrouter/google/gemini-3.8-flash': 'opencode.gemini-flash.json',
    'openrouter/xiaomi/mimo-v2.6-flash': 'opencode.mimo-flash.json',
    'openrouter/google/gemini-4-argon': 'opencode.gemini-argon.json',
    'openrouter/meta/muse-wonder': 'opencode.muse-wonder.json',
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': 'opencode.nemotron-ultra-free.json',
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b': 'opencode.nemotron-ultra.json',
    'openrouter/tencent/hy4-preview': 'opencode.hy4-preview.json',
    'openrouter/openai/gpt-6-luna': 'opencode.gpt-luna.json',
    'openrouter/upstage/solar-mini4': 'opencode.solar-mini4.json',
    'openrouter/meta/muse-spark-1.3-contributor': 'opencode.muse-spark-contrib.json',
    'openrouter/google/gemma-4-31b-it': 'opencode.gemma4-31b.json'
};

// ---------- args ----------
const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const nAgents = parseInt(arg('agents', '1'));
const minutes = parseFloat(arg('minutes', '30'));
/** human: a person plays the one account in their own browser (a human baseline); no agents, no model. */
const backend = arg('backend', 'opencode') as 'opencode' | 'claude' | 'human';
const human = backend === 'human';
const model = human ? 'human' : arg('model', backend === 'opencode' ? 'openrouter/deepseek/deepseek-v4.1-flash' : 'haiku');
const label = arg('label', '');
const record = args.includes('--record');
if (human && (nAgents !== 1 || record)) {
    console.error('--backend human plays one account (--agents 1) and records positions only (no --record)');
    process.exit(1);
}
/** strongest: best NPC type, top-3 kill values. unique: sum of ln(1 + level) over distinct enemies. */
const mode = arg('mode', 'strongest') as 'strongest' | 'unique';
if (mode !== 'strongest' && mode !== 'unique') {
    console.error(`--mode must be strongest or unique`);
    process.exit(1);
}
/** Stop all agents once live model spend reaches this many dollars (0 = no cap). */
const budgetUsd = parseFloat(arg('budget', '0'));
if (backend === 'opencode' && !OPENCODE_CONFIGS[model]) {
    console.error(`No OpenCode config for ${model}; add it to OPENCODE_CONFIGS (and PRICING).`);
    process.exit(1);
}
if (budgetUsd > 0 && !PRICING[model]) {
    console.error(`--budget needs a PRICING entry for ${model}`);
    process.exit(1);
}
const frameInterval = arg('frame-interval', '2');
/** A human-written plan appended to every agent's prompt (copied into the run dir as strategy.txt). */
const strategyFile = arg('strategy', '');
if (strategyFile && !existsSync(strategyFile)) {
    console.error(`strategy file not found: ${strategyFile}`);
    process.exit(1);
}
const strategy = strategyFile ? readFileSync(strategyFile, 'utf-8').trim() : '';

// Outside the agent-visible tree; referenced as {file:...} in opencode.deepseek.json.
const KEY_FILE = join(process.env.USERPROFILE ?? '', '.runebench', 'openrouter.key');
if (backend === 'opencode' && !existsSync(KEY_FILE)) {
    console.error(`OpenRouter key file not found: ${KEY_FILE}`);
    process.exit(1);
}

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const stamp = Date.now().toString(36).slice(-6);
// Fixed call-sign names, reset every run: the previous run's save and bot folder
// are archived into its run dir at teardown, so each run starts from a fresh account.
const CALL_SIGNS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
if (nAgents > CALL_SIGNS.length) throw new Error(`at most ${CALL_SIGNS.length} agents`);
const team = human ? ['Human'] : CALL_SIGNS.slice(0, nAgents);
// Refuse to start without enough OpenRouter credit: when the account runs dry every request fails
// with a 402, and the agents' relaunch loop would just produce an empty, zero-score run. Both the
// account balance and the key's own limit count. The key is only sent to OpenRouter.
if (backend === 'opencode' && model.startsWith('openrouter/')) {
    const need = budgetUsd || 1;
    const auth = { Authorization: `Bearer ${readFileSync(KEY_FILE, 'utf-8').trim()}` };
    try {
        const credits = ((await (await fetch('https://openrouter.ai/api/v1/credits', { headers: auth })).json()) as any).data;
        const key = ((await (await fetch('https://openrouter.ai/api/v1/key', { headers: auth })).json()) as any).data;
        const account = credits.total_credits - credits.total_usage;
        const left = Math.min(account, key.limit_remaining ?? Infinity);
        if (left < need) {
            console.error(`Not enough OpenRouter credit: $${left.toFixed(2)} left (account $${account.toFixed(2)}, key limit $${(key.limit_remaining ?? Infinity).toFixed(2)}), run needs $${need}. Top up, or lower --budget.`);
            process.exit(3);
        }
    } catch (err) {
        console.error(`warning: couldn't check OpenRouter credit (${(err as Error).message}); starting anyway`);
    }
}

const counterFile = join(ROOT, 'runs', '.counter');
const runNo = (existsSync(counterFile) ? parseInt(readFileSync(counterFile, 'utf-8')) || 0 : 0) + 1;
mkdirSync(join(ROOT, 'runs'), { recursive: true });
writeFileSync(counterFile, String(runNo));
const runTag = String(runNo).padStart(3, '0');
const SAVES = join(RS_SDK, 'server', 'engine', 'data', 'players', 'main');
const saveFile = (name: string) => join(SAVES, `${name.toLowerCase()}.sav`);
const runDir = join(ROOT, 'runs', `${runId}-r${runTag}-${nAgents}x-${backend}${mode === 'unique' ? '-unique' : ''}${label ? '-' + label : ''}`);
mkdirSync(runDir, { recursive: true });
const notesRel = 'bots/_team/notes.md';
if (strategy) writeFileSync(join(runDir, 'strategy.txt'), strategy + '\n');

/**
 * A disconnected character can stay in the world for a while (e.g. mid-fight). Logging in
 * again would reconnect to that live character, and its eventual logout rewrites the save,
 * so never touch saves until the engine reports the names offline.
 */
async function waitOffline(names: string[], timeoutMs = 180_000): Promise<void> {
    const wanted = new Set(names.map(n => n.toLowerCase()));
    const until = Date.now() + timeoutMs;
    for (;;) {
        let online: string[] = [];
        try {
            const players = (await (await fetch('http://localhost:8888/playerpositions')).json()) as Array<{ name: string }>;
            online = players.map(p => p.name).filter(n => wanted.has(n.toLowerCase()));
        } catch {
            online = ['(engine unreachable)'];
        }
        if (!online.length) return;
        if (Date.now() > until) throw new Error(`still online after ${timeoutMs / 1000}s: ${online.join(', ')}`);
        await new Promise(r => setTimeout(r, 2000));
    }
}

/**
 * Login prefers the engine's database checkpoint (market.sqlite `accounts`, written for every
 * online player on GE/trade/autosave checkpoints) over the .sav file, so a reset has to remove
 * that row too. Archives the checkpoint first. Refuses if the bot has GE offers, since those
 * hold items/coins and are referenced by trade history.
 */
function takeCheckpoints(names: string[], archiveDir: string): string[] {
    const path = join(RS_SDK, 'server', 'engine', 'data', 'market.sqlite');
    if (!existsSync(path)) return [];
    const db = new Database(path);
    db.exec('PRAGMA busy_timeout = 5000');
    const taken: string[] = [];
    try {
        for (const name of names) {
            const owner = name.toLowerCase();
            const offers = db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM offers WHERE owner = ?').get(owner)?.n ?? 0;
            if (offers) throw new Error(`${name} has ${offers} GE offer row(s) in market.sqlite; resolve them before reusing the name`);
            const row = db.query<{ save: Uint8Array }, [string]>('SELECT save FROM accounts WHERE owner = ?').get(owner);
            if (!row) continue;
            mkdirSync(archiveDir, { recursive: true });
            writeFileSync(join(archiveDir, `${name}.checkpoint.sav`), row.save);
            db.query('DELETE FROM accounts WHERE owner = ?').run(owner);
            taken.push(name);
        }
    } finally {
        db.close();
    }
    return taken;
}

// Anything left over from a crashed run would leak state into this one: move it aside.
await waitOffline(team);
{
    const taken = takeCheckpoints(team, join(ROOT, 'runs', 'orphaned', runId));
    if (taken.length) console.log(`moved leftover DB checkpoints for ${taken.join(', ')} -> runs/orphaned/${runId}`);
}
for (const path of [...team.flatMap(n => [saveFile(n), join(RS_SDK, 'bots', n)]), join(RS_SDK, 'bots', '_team')]) {
    if (!existsSync(path)) continue;
    const orphanDir = join(ROOT, 'runs', 'orphaned', runId);
    mkdirSync(orphanDir, { recursive: true });
    renameSync(path, join(orphanDir, basename(path)));
    console.log(`moved leftover ${path} -> ${orphanDir}`);
}

const children: Subprocess[] = [];
function killTree(p: Subprocess) {
    if (p.exitCode === null) spawnSync(['taskkill', '/PID', String(p.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
}
process.on('SIGINT', () => {
    children.forEach(killTree);
    process.exit(130);
});
// An aborted setup (thrown error) must not leave clients or agents running.
process.on('exit', () => children.forEach(killTree));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (msg: string) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(line);
    appendFileSync(join(runDir, 'orchestrator.log'), line + '\n');
};

// ---------- 0. fresh gateway ----------
// The gateway keeps each bot name's chat in memory (GET /chat/:name, which sdk/chat.ts reads) for as
// long as it runs, and bot names repeat every run, so a shared gateway would show agents earlier
// runs' chat. Each run starts its own and kills it at teardown with the other children.
const gatewayUp = () => fetch('http://localhost:7780/chat/_probe', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
if (await gatewayUp()) throw new Error('a gateway is already listening on 7780; stop it (run.ts starts a fresh one per run)');
children.push(spawn(['bun', 'run', 'gateway'], { cwd: join(RS_SDK, 'server', 'gateway'), stdout: Bun.file(join(runDir, 'gateway.log')), stderr: Bun.file(join(runDir, 'gateway.log.err')) }));
for (let i = 0; !(await gatewayUp()); i++) {
    if (i > 60) throw new Error('gateway did not start; see gateway.log.err');
    await sleep(500);
}

// ---------- 1. fresh bots ----------
function botEnv(name: string) {
    return {
        BOT_USERNAME: name,
        PASSWORD: 'bench' + stamp,
        SERVER: 'localhost:8888',
        GATEWAY_URL: 'ws://localhost:7780',
        SHOW_CHAT: nAgents > 1 ? 'true' : 'false',
        // Lite clients re-censor chat locally; the engine side is NODE_PROFANITY_FILTER=false.
        PROFANITY_FILTER: 'false',
        TELEMETRY: 'false'
    };
}
for (const name of team) {
    const dir = join(RS_SDK, 'bots', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bot.env'), Object.entries(botEnv(name)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
if (nAgents > 1) {
    mkdirSync(join(RS_SDK, 'bots', '_team'), { recursive: true });
    writeFileSync(join(RS_SDK, notesRel), `# Team notes (${team.join(', ')})\n\n`);
}
log(`run ${runDir}`);
log(`team ${team.join(', ')} | backend ${backend} | model ${model} | ${minutes} min | mode ${mode}`);

// ---------- 2. headless clients + identical start ----------
async function waitForText(file: string, re: RegExp, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (existsSync(file) && re.test(readFileSync(file, 'utf-8'))) return true;
        await sleep(500);
    }
    return false;
}
// --record swaps the lite runner for a headless browser client that screenshots the game.
for (const name of team) {
    if (human) {
        // The full client (no "minimal"), logged in as this account, in the default browser. It
        // registers with the gateway like the headless clients, so setup-bot can skip the tutorial.
        const url = `http://localhost:8888/bot?bot=${encodeURIComponent(name)}&password=${encodeURIComponent(botEnv(name).PASSWORD)}`;
        spawnSync(['cmd', '/c', 'start', '""', url]);
        log(`opened the game client for ${name} in the default browser`);
    } else if (record) {
        const out = join(runDir, `browser-${name}.log`);
        const p = spawn(['bun', join(import.meta.dir, 'browser-client.ts'), name, botEnv(name).PASSWORD, join(runDir, `frames-${name}`), frameInterval], { cwd: ROOT, stdout: Bun.file(out), stderr: Bun.file(out + '.err') });
        children.push(p);
        if (!(await waitForText(out, /INGAME/, 120_000))) throw new Error(`browser client for ${name} never got in game; see ${out}.err`);
    } else {
        const out = join(runDir, `lite-${name}.log`);
        const p = spawn(['bun', 'src/lite/runner.ts', name], { cwd: join(RS_SDK, 'server', 'webclient'), stdout: Bun.file(out), stderr: Bun.file(out + '.err') });
        children.push(p);
        if (!(await waitForText(out, /registering as/, 90_000))) throw new Error(`lite client for ${name} never registered; see ${out}`);
    }
    let setupOut = '';
    for (let attempt = 0; attempt < (human ? 10 : 3) && !/READY/.test(setupOut); attempt++) {
        if (attempt) await sleep(3000);
        const setup = spawnSync(['bun', join(import.meta.dir, 'setup-bot.ts')], { cwd: RS_SDK, env: { ...process.env, ...botEnv(name) } });
        setupOut = setup.stdout.toString();
        writeFileSync(join(runDir, `setup-${name}.log`), setupOut + setup.stderr.toString());
    }
    if (!/READY/.test(setupOut)) throw new Error(`setup failed for ${name}; see setup-${name}.log`);
    const cb = setupOut.match(/cb=(\d+)/)?.[1];
    if (cb !== '3') throw new Error(`${name} is not a fresh character (combat ${cb}); a stale save survived the reset`);
    // Every bot must start at the Lumbridge spawn, never on Tutorial Island or elsewhere.
    const [x, z] = (setupOut.match(/READY (\d+),(\d+)/) ?? []).slice(1).map(Number);
    if (!(Math.abs(x - 3222) <= 10 && Math.abs(z - 3222) <= 10)) throw new Error(`${name} did not reach the Lumbridge spawn (at ${x},${z})`);
    log(`${name} ready at ${x},${z} (fresh, combat 3)`);
}

// Live view: open runs/<run>/live.html in a browser. status.js is rewritten every poll.
if (record) {
    const html = readFileSync(join(import.meta.dir, 'live-template.html'), 'utf-8')
        .replace('{{TEAM_JSON}}', JSON.stringify(team))
        .replace('{{INTERVAL}}', String(Math.max(1000, parseFloat(frameInterval) * 1000)));
    writeFileSync(join(runDir, 'live.html'), html);
    // Agent feed for the page (agents.js): tails transcripts + team notes, exits after results.json.
    const feedLog = join(runDir, 'live-feed.log');
    children.push(spawn(['bun', join(import.meta.dir, 'live.ts'), runDir, join(RS_SDK, notesRel)], { cwd: ROOT, stdout: Bun.file(feedLog), stderr: Bun.file(feedLog + '.err') }));
    log(`live view: ${join(runDir, 'live.html')}`);
}

// ---------- 3. live ledger tail ----------
// Copy new ledger lines into the run dir as they appear, so the score comes
// from what the engine wrote during the run, not from the file at the end.
let ledgerOffset = existsSync(LEDGER) ? fstatSync(openSync(LEDGER, 'r')).size : 0;
const kills: Kill[] = [];
const teamSet = new Set(team.map(t => t.toLowerCase())); // the ledger stores lowercase usernames
function pollLedger() {
    if (!existsSync(LEDGER)) return;
    const fd = openSync(LEDGER, 'r');
    const size = fstatSync(fd).size;
    if (size > ledgerOffset) {
        const buf = Buffer.alloc(size - ledgerOffset);
        readSync(fd, buf, 0, buf.length, ledgerOffset);
        const text = buf.toString('utf-8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl >= 0) {
            ledgerOffset += Buffer.byteLength(text.slice(0, lastNl + 1));
            for (const k of parseLedger(text.slice(0, lastNl + 1))) {
                if (!k.contributors.some(c => c.username && teamSet.has(c.username.toLowerCase()))) continue;
                kills.push(k);
                appendFileSync(join(runDir, 'kills.jsonl'), JSON.stringify(k) + '\n');
                log(`kill: ${k.killer} -> ${k.npcName} (lvl ${k.combatLevel}, hp ${k.maxHp}, ttk ${k.ttkTicks ?? '?'} ticks)`);
            }
        }
    }
    closeSync(fd);
    if (record) {
        const s = (mode === 'unique' ? scoreUnique : scoreRun)(kills, team, startMs, Date.now());
        const status = {
            minutes,
            elapsed: ((Date.now() - startMs) / 60_000).toFixed(1),
            score: s.score.toFixed(1),
            kills: s.totalKills,
            recent: kills.slice(-15).reverse().map(k => `${k.ts.slice(11, 19)}  ${k.killer} -> ${k.npcName} (lvl ${k.combatLevel}, ttk ${k.ttkTicks ?? '?'}t)`)
        };
        writeFileSync(join(runDir, 'status.js'), `window.STATUS=${JSON.stringify(status)};`);
    }
}

function buildTimelapses() {
    const videos: string[] = [];
    for (const name of team) {
        const dir = join(runDir, `frames-${name}`);
        if (!existsSync(join(dir, 'frame-00000.jpg'))) continue;
        const mp4 = join(runDir, `timelapse-${name}.mp4`);
        const r = spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '15', '-i', join(dir, 'frame-%05d.jpg'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
        if (r.exitCode === 0) videos.push(mp4);
        else log(`ffmpeg failed for ${name}: ${r.stderr.toString().slice(0, 300)}`);
    }
    if (videos.length > 1) {
        const inputs = videos.flatMap(v => ['-i', v]);
        spawnSync(['ffmpeg', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', `hstack=inputs=${videos.length}:shortest=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(runDir, 'timelapse-team.mp4')]);
    }
    if (videos.length) log(`timelapse: ${videos.length > 1 ? join(runDir, 'timelapse-team.mp4') : videos[0]}`);
}

// ---------- 4. agents ----------
// A person needs a moment to find the window after the tutorial skip: their clock starts at their
// first step off the spawn tile (or after 10 minutes), where an agent's starts at its launch.
if (human) {
    log('READY: the clock starts when you first move');
    const until = Date.now() + 600_000;
    let at: string | null = null;
    while (Date.now() < until) {
        try {
            const me = ((await (await fetch('http://localhost:8888/playerpositions')).json()) as Array<{ name: string; x: number; z: number }>).find(p => p.name.toLowerCase() === 'human');
            if (me && at !== null && `${me.x},${me.z}` !== at) break;
            if (me && at === null) at = `${me.x},${me.z}`;
        } catch {}
        await sleep(250);
    }
}
const startMs = Date.now();
const deadlineMs = startMs + minutes * 60_000;
const deadlineIso = new Date(deadlineMs).toISOString();

function prompt(name: string): string {
    if (mode === 'unique') return uniquePrompt(name);
    const others = team.filter(t => t !== name);
    const teamPart = others.length
        ? `\nYou are on a team of ${team.length}. Teammates (each controlled by another AI agent): ${others.join(', ')}.
The team score is the single best kill by ANY team member, so you share one goal. How you split up the work is up to you.
Coordinate through the shared notes file ${notesRel} (all teammates can read and edit it) and/or in-game chat (sdk.say, sdk.dm, sdk.getChat).\n`
        : '';
    return `You control the bot "${name}" in a 2004-era RuneScape server via the rs-agent MCP tool execute_code (bot_name: "${name}").
The bot is a fresh level-3 character standing in Lumbridge, tutorial already done.
${teamPart}
OBJECTIVE: defeat the strongest NPC you can, efficiently. A kill is worth
  (NPC combat level) x HP / (HP + seconds from the first hit to its death)
where HP is the NPC's max hitpoints. In other words it scales with your damage per second against it:
1 HP/s keeps 50% of the level, 2 HP/s 67%, 4 HP/s 80%, 0.5 HP/s only 33%. Slow grinds are worth little.
Your score is the average value of your ${others.length ? "team's " : ''}3 best kills of a single NPC type, using whichever type scores highest
(fewer than 3 kills of a type count the missing ones as 0). Kill credit goes to whoever deals the most damage to the NPC.
Fight time is measured in game time (0.6s per game tick); the server runs faster than real time.
Kills are recorded by the game server automatically; you do not need to report them.

DEADLINE: ${deadlineIso} (${minutes} minutes from now; Date.now() inside execute_code gives the current time).
Work until the deadline. Do not stop early to write a summary.

RULES: only control your own bot "${name}". Only create or edit files under bots/${name}/${others.length ? ` and ${notesRel}` : ''}.
Stay inside this repository; do not read or list anything outside it.
Do not modify or restart the game server, gateway, SDK, or MCP code.

Useful references: CLAUDE.md, sdk/API.md, learnings/, wiki/ (npcs/ lists monster levels and locations).`;
}

function uniquePrompt(name: string): string {
    // Prompt text from r042 (tidied for brevity; same content as r019-r041). From r047 the score
    // examples are bare levels: r019-r046 named Chicken, Goblin, Guard and Lesser demon, and agents
    // read those as targets (a Lumbridge "Guard" hunt, Lesser demon plans).
    const others = team.filter(t => t !== name);
    const we = others.length ? 'the team' : 'you';
    const teamPart = others.length
        ? `
TEAM: you and ${others.join(', ')}, each controlled by a separate AI agent. You share one score.
Split the work however you like, and trade or give each other items and coins if useful.
Coordinate through ${notesRel} (shared, everyone can edit) and in-game chat (sdk.say, sdk.dm, sdk.getChat).
`
        : '';
    return `You control the bot "${name}" in a 2004-era RuneScape server, through the rs-agent MCP tool execute_code
(bot_name: "${name}"). It is a fresh level-3 character in Lumbridge, tutorial done.
${teamPart}
GOAL: kill as many different enemies as possible before the deadline.
- An enemy is its in-game NPC name: every "Goblin" is one enemy, whatever its level or location.
- Score = sum, over distinct enemies ${we} killed, of ln(1 + highest combat level killed).
  For example, a level 1 enemy is worth 0.69, level 5 is 1.79, level 21 is 3.09, level 82 is 4.42.
- Repeat kills add nothing, but training on easy enemies is fine.
- A kill counts for whoever dealt the most damage. The server records kills, but there is no
  scoreboard: tracking what ${we} ${others.length ? 'has' : 'have'} killed is up to ${others.length ? 'you all' : 'you'}.

DEADLINE: ${deadlineIso} (${minutes} minutes from now; Date.now() in execute_code gives the time).
Keep working until then; don't stop to write a summary.

RULES:
- Control only your own bot, ${name}.
- Create or edit files only under bots/${name}/${others.length ? ` and ${notesRel}` : ''}. Don't read or list anything outside this repository.
- Don't modify or restart the game server, gateway, SDK or MCP code.

REFERENCES: CLAUDE.md, sdk/API.md, learnings/, wiki/ (wiki/npcs/ lists enemy levels and locations).${strategy ? '\n\n' + strategy : ''}`;
}

type AgentStats = { name: string; launches: number; costUsd: number; inputTokens: number; cachedTokens: number; outputTokens: number; steps: number };
const stats: Record<string, AgentStats> = Object.fromEntries(team.map(n => [n, { name: n, launches: 0, costUsd: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, steps: 0 }]));

/** Pull the conversation id out of an agent transcript so a relaunch can resume it. */
function sessionIdFrom(out: string): string | null {
    if (!existsSync(out)) return null;
    const text = readFileSync(out, 'utf-8');
    if (backend === 'opencode') return text.match(/"sessionID":"([^"]+)"/)?.[1] ?? null;
    return text.match(/"session_id":"([^"]+)"/)?.[1] ?? null;
}

function launch(name: string, text: string, sessionId: string | null): { proc: Subprocess; out: string } {
    const n = ++stats[name].launches;
    const out = join(runDir, `agent-${name}-${n}.jsonl`);
    let cmd: string[];
    let env: Record<string, string | undefined> = { ...process.env };
    if (backend === 'opencode') {
        cmd = [OPENCODE_EXE, '--model', model, 'run', '--format=json', ...(sessionId ? ['--session', sessionId] : []), text];
        // The API key comes from KEY_FILE via the opencode config, never the env:
        // anything in env is visible to the agent's shell commands.
        env = Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)));
        env.OPENCODE_CONFIG = join(import.meta.dir, OPENCODE_CONFIGS[model]);
        // OpenCode cancels tool calls at experimental.mcp_timeout (5 min) and the output is lost;
        // the MCP server (inherits this env) stops code at 4.5 min instead and returns its output.
        env.MCP_EXECUTE_MAX_MINUTES = '4.5';
        // OpenCode takes its project dir from PWD, not the spawn cwd. If PWD is left
        // as the orchestrator's dir, external_directory protects the wrong tree.
        env.PWD = RS_SDK;
    } else {
        cmd = ['claude', '-p', text, ...(sessionId ? ['--resume', sessionId] : []), '--model', model, '--mcp-config', '.mcp.json', '--strict-mcp-config',
            '--allowedTools', 'mcp__rs-agent__execute_code,mcp__rs-agent__list_bots,Read,Grep,Glob,Write,Edit',
            '--output-format', 'json'];
    }
    const proc = spawn(cmd, { cwd: RS_SDK, env, stdout: Bun.file(out), stderr: Bun.file(out + '.err'), stdin: 'ignore' });
    children.push(proc);
    log(`${name} launch #${n}${sessionId ? ` (resuming ${sessionId})` : ''}`);
    return { proc, out };
}

function accountUsage(name: string, out: string) {
    if (!existsSync(out)) return;
    const s = stats[name];
    const text = readFileSync(out, 'utf-8');
    if (backend === 'claude') {
        try {
            const d = JSON.parse(text);
            s.costUsd += d.total_cost_usd ?? 0;
            s.inputTokens += (d.usage?.input_tokens ?? 0) + (d.usage?.cache_creation_input_tokens ?? 0);
            s.cachedTokens += d.usage?.cache_read_input_tokens ?? 0;
            s.outputTokens += d.usage?.output_tokens ?? 0;
            s.steps += d.num_turns ?? 0;
        } catch { /* killed mid-run: no final JSON */ }
        return;
    }
    const price = PRICING[model];
    for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type !== 'step_finish') continue;
        const t = ev.part?.tokens ?? {};
        const input = (t.input ?? 0) + (t.cache?.write ?? 0), cached = t.cache?.read ?? 0, output = (t.output ?? 0) + (t.reasoning ?? 0);
        s.inputTokens += input;
        s.cachedTokens += cached;
        s.outputTokens += output;
        s.steps++;
        s.costUsd += price ? stepCost(model, t) : (ev.part?.cost ?? 0);
    }
}

/** No transcript output for this long means a hung request. Must exceed experimental.mcp_timeout (5 min) so a legitimately long tool call is not killed. */
const STALL_MS = 420_000;

// ---------- budget cap ----------
// Live spend across every transcript so far (OpenCode writes a step_finish with token counts
// per model call). Overshoot is at most one in-flight call per agent.
const runningProcs = new Map<string, Subprocess>();
let budgetHitAt: number | null = null;
let creditsOutAt: number | null = null; // OpenRouter answered 402: the account ran out mid-run
function spendSoFar(): number {
    let total = 0;
    for (const f of readdirSync(runDir).filter(f => /^agent-.+\.jsonl$/.test(f))) {
        for (const line of readFileSync(join(runDir, f), 'utf-8').split('\n')) {
            if (!line.includes('"step_finish"')) continue;
            try {
                total += stepCost(model, JSON.parse(line).part?.tokens);
            } catch { /* partial line */ }
        }
    }
    return total;
}
const budgetTicker = budgetUsd > 0 ? setInterval(() => {
    if (budgetHitAt !== null) return;
    const spent = spendSoFar();
    if (spent < budgetUsd) return;
    budgetHitAt = Date.now();
    log(`BUDGET reached ($${spent.toFixed(2)} >= $${budgetUsd}); stopping all agents`);
    for (const p of runningProcs.values()) killTree(p);
}, 15_000) : null;

// Relaunches resume the same conversation so the agent keeps its full history.
// If resuming keeps failing fast, fall back to a fresh conversation with the full prompt.
async function agentLoop(name: string) {
    let sessionId: string | null = null;
    let fastFails = 0;
    while (budgetHitAt === null && creditsOutAt === null && Date.now() < deadlineMs - 30_000 && fastFails < 4) {
        const remaining = Math.round((deadlineMs - Date.now()) / 60_000);
        const text = sessionId
            ? `Your previous turn ended early (an API timeout or you stopped), with about ${remaining} minutes still remaining before the deadline. Check your bot's current state and CONTINUE working toward the objective. Do not write a summary.`
            : (stats[name].launches ? `You were working on this task but stopped with about ${remaining} minutes still remaining. Check your bot's current state and CONTINUE. Do not write a summary.\n\n` : '') + prompt(name);
        const t0 = Date.now();
        const { proc, out } = launch(name, text, sessionId);
        runningProcs.set(name, proc);
        const timer = setTimeout(() => killTree(proc), Math.max(0, deadlineMs - Date.now()));
        // Stall watchdog: OpenCode's request timeout doesn't cover a stream that stalls
        // mid-response, so kill an agent whose transcript goes quiet; the loop resumes it.
        const watchdog = setInterval(() => {
            const lastWrite = existsSync(out) ? statSync(out).mtimeMs : t0;
            if (Date.now() - Math.max(lastWrite, t0) > STALL_MS) {
                log(`${name} silent for ${STALL_MS / 1000}s; restarting it`);
                killTree(proc);
            }
        }, 10_000);
        await proc.exited;
        runningProcs.delete(name);
        clearTimeout(timer);
        clearInterval(watchdog);
        accountUsage(name, out);
        if (creditsOutAt === null && existsSync(out) && readFileSync(out, 'utf-8').includes('"statusCode":402')) {
            creditsOutAt = Date.now();
            log(`OUT OF CREDITS: OpenRouter answered 402 for ${name}; stopping all agents. This run is invalid.`);
            for (const p of runningProcs.values()) killTree(p);
        }
        const dur = (Date.now() - t0) / 1000;
        log(`${name} exited after ${dur.toFixed(0)}s (code ${proc.exitCode})`);
        fastFails = dur < 15 ? fastFails + 1 : 0;
        if (fastFails >= 2 && sessionId) {
            log(`${name} resume keeps failing; starting a fresh conversation`);
            sessionId = null;
        } else {
            sessionId = sessionIdFrom(out) ?? sessionId;
        }
    }
    if (fastFails >= 4) log(`${name} gave up after 4 fast failures; check agent-${name}-*.jsonl.err`);
}

writeFileSync(join(runDir, 'kills.jsonl'), '');
log(`start; deadline ${deadlineIso}`);
const ticker = setInterval(pollLedger, 2000);
// Team positions 4x a second from the engine's /playerpositions (what /mapview shows), for replays.
// Agents run ~40 tiles/s at this tick rate, so 1 Hz samples cut corners through buildings.
async function pollPositions() {
    try {
        const all = (await (await fetch('http://localhost:8888/playerpositions', { signal: AbortSignal.timeout(240) })).json()) as Array<{ name: string; x: number; z: number; level: number }>;
        const mine = all.filter(p => teamSet.has(p.name.toLowerCase())).map(p => ({ name: p.name, x: p.x, z: p.z, level: p.level }));
        appendFileSync(join(runDir, 'positions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), players: mine }) + '\n');
    } catch {}
}
const positionTicker = setInterval(pollPositions, 250);
if (human) {
    await sleep(deadlineMs - Date.now());
    log(`TIME'S UP; kills from now on don't count. Log out of the game so the save can be archived.`);
} else {
    // Stagger launches: simultaneous OpenCode starts collide on its shared database ("database is locked").
    await Promise.all(team.map(async (name, i) => {
        await sleep(i * 3000);
        await agentLoop(name);
    }));
}
clearInterval(ticker);
clearInterval(positionTicker);
if (budgetTicker) clearInterval(budgetTicker);
const endMs = Math.min(Date.now(), deadlineMs, budgetHitAt ?? Infinity);
await sleep(3000);
pollLedger();

// ---------- 5. teardown + score ----------
children.forEach(killTree);
if (record) buildTimelapses();

// Archive each bot's final save + files into the run dir, freeing the names for the next run.
// The engine writes the save on logout, shortly after the client dies: wait for it.
await waitOffline(team, human ? 1_800_000 : 180_000).catch(err => log(`warning: ${err.message}`));
for (const name of team) {
    const save = saveFile(name);
    const waitUntil = Date.now() + 60_000;
    while (Date.now() < waitUntil && !(existsSync(save) && statSync(save).mtimeMs >= endMs)) await sleep(1000);
    if (!existsSync(save) || statSync(save).mtimeMs < endMs) log(`warning: no post-run save for ${name}; archiving what exists`);
    await sleep(2000); // let the logout settle so nothing rewrites the save after the move
    const archive = join(runDir, 'final-state');
    mkdirSync(archive, { recursive: true });
    if (existsSync(save)) renameSync(save, join(archive, `${name}.sav`));
    if (existsSync(join(RS_SDK, 'bots', name))) renameSync(join(RS_SDK, 'bots', name), join(archive, `bot-${name}`));
}
if (existsSync(join(RS_SDK, 'bots', '_team'))) renameSync(join(RS_SDK, 'bots', '_team'), join(runDir, 'final-state', 'team'));
try {
    takeCheckpoints(team, join(runDir, 'final-state'));
} catch (err) {
    log(`warning: ${(err as Error).message}`);
}
const totalCost = Object.values(stats).reduce((a, s) => a + s.costUsd, 0);
const runInfo = {
    runDir,
    mode,
    backend,
    model,
    nAgents,
    minutes,
    team,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    strategy: strategy || undefined,
    invalid: creditsOutAt ? `OpenRouter out of credits (402) at ${new Date(creditsOutAt).toISOString()}` : undefined
};
const spend = {
    costUsd: totalCost,
    budgetUsd: budgetUsd || null,
    budgetStoppedAt: budgetHitAt ? new Date(budgetHitAt).toISOString() : null,
    agents: Object.values(stats),
    timing: human ? null : runTiming(runDir, minutes)
};
if (mode === 'unique') {
    const u = scoreUnique(kills, team, startMs, endMs);
    writeFileSync(join(runDir, 'results.json'), JSON.stringify({ ...runInfo, ...u, ...spend }, null, 2));
    log(`SCORE ${u.score.toFixed(2)} | ${u.enemies.length} enemies (level sum ${u.levelSum}): ${u.enemies.map(e => `${e.name} ${e.level}`).join(', ') || '-'} | unique by agent ${team.map(t => `${t} ${u.uniqueByAgent[t]}`).join(', ')} | overlap ${u.overlap.length} | kills ${u.totalKills} (${u.nonScoringKills} non-scoring) | cost $${totalCost.toFixed(4)}`);
    finish();
}
const summary = scoreRun(kills, team, startMs, endMs);
const results = {
    ...runInfo,
    score: summary.score,
    bestType: summary.bestType,
    bestKill: summary.bestKill,
    altScores: summary.alt,
    totalKills: summary.totalKills,
    killsByAgent: summary.killsByAgent,
    distinctNpcs: summary.distinctNpcs,
    bestOverTime: summary.bestOverTime,
    ...spend
};
writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2));
log(`SCORE ${summary.score.toFixed(2)} (top-3 ${summary.bestType?.npcName ?? '-'}, ${summary.bestType?.kills ?? 0} kills) | best single ${summary.bestKill?.npcName ?? '-'} (lvl ${summary.bestKill?.combatLevel ?? '-'}, hp ${summary.bestKill?.maxHp ?? '-'}, ttk ${summary.bestKill?.ttkSeconds?.toFixed(1) ?? '?'}s, ${summary.bestKill?.dps?.toFixed(2) ?? '?'} dps) by ${summary.bestKill?.killer ?? '-'} | kills ${summary.totalKills} | cost $${totalCost.toFixed(4)}`);
finish();

/** Exit; a run that hit 402s is renamed *-NOCREDITS and exits 3, so `&&` chains stop. */
function finish(): never {
    if (!creditsOutAt) process.exit(0);
    log('INVALID RUN (OpenRouter out of credits); renaming the run dir with -NOCREDITS');
    try { renameSync(runDir, runDir + '-NOCREDITS'); } catch (err) { console.error(`rename failed: ${(err as Error).message}`); }
    process.exit(3);
}
