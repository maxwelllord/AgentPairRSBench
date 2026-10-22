// Builds timelapse-grid.mp4 for a recorded run: the bots' screen captures in a 2-column grid,
// with the spare cell used for a stats panel (score and its curve, clock, spend, and per-agent
// combat level, weapon, kills, deaths and last kill), all as of each frame's moment in the run.
//   bun bench/grid.ts runs/<runId>              -> timelapse-grid.mp4
//   bun bench/grid.ts runs/<runId> --still 20   -> grid-still-20m.jpg (one frame, to check the layout)
// Unique-enemies runs (results.mode 'unique') show the enemy list instead of the best type; with an
// even number of agents the panel spans the bottom row.
// Stats come from kills.jsonl (score, kills) and the agents' logs (combat level, weapon and
// deaths from execute_code world-state output; spend from step tokens), so they update only
// as often as those are written.

import puppeteer from '../rs-sdk/node_modules/puppeteer';
import { spawnSync } from 'bun';
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { parseLedger, scoreRun, scoreUnique } from './score';
import { displayName } from './npc-names';
import { stepCost } from './pricing';

const W = 765, H = 503, FPS = 15;
/** Past this, an agent's combat level and weapon are shown as "as of N min ago". */
const STALE_MS = 90_000;

const runDir = process.argv[2];
const stillIdx = process.argv.indexOf('--still');
const stillMinute = stillIdx > 0 ? Number(process.argv[stillIdx + 1]) : null;
if (!runDir || !existsSync(join(runDir, 'results.json'))) {
    console.error('Usage: bun bench/grid.ts <runDir>');
    process.exit(1);
}
const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf-8'));
const team: string[] = results.team;
const startMs = Date.parse(results.startedAt);
const endMs = Date.parse(results.endedAt);
const kills = existsSync(join(runDir, 'kills.jsonl')) ? parseLedger(readFileSync(join(runDir, 'kills.jsonl'), 'utf-8')) : [];
const runTag = basename(runDir).match(/-(r\d+)-/)?.[1] ?? basename(runDir);
const modelName = String(results.model).split('/').pop();
const unique = results.mode === 'unique';

// ---------- frames ----------
type Frame = { path: string; ms: number };
const frames: Record<string, Frame[]> = {};
for (const name of team) {
    const dir = join(runDir, `frames-${name}`);
    frames[name] = existsSync(dir)
        ? readdirSync(dir).filter(f => /^frame-\d+\.jpg$/.test(f)).sort()
            .map(f => ({ path: join(dir, f), ms: statSync(join(dir, f)).mtimeMs }))
        : [];
}
const sample = frames[team[0]];
const intervalMs = sample.length > 2 ? Math.max(500, (sample.at(-1)!.ms - sample[0].ms) / (sample.length - 1)) : 2000;
function frameAt(name: string, t: number): string | null {
    const fs = frames[name];
    if (!fs.length) return null;
    let lo = 0, hi = fs.length - 1, best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fs[mid].ms <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return pathToFileURL(fs[best].path).href;
}

// ---------- agent log events ----------
type Obs = { ms: number; combat?: number; weapon?: string; deaths: number };
const obs: Record<string, Obs[]> = Object.fromEntries(team.map(n => [n, []]));
const spend: Array<{ ms: number; usd: number }> = [];
for (const f of readdirSync(runDir).filter(f => /^agent-.+-\d+\.jsonl$/.test(f))) {
    const name = f.match(/^agent-(.+)-\d+\.jsonl$/)![1];
    for (const line of readFileSync(join(runDir, f), 'utf-8').split('\n')) {
        if (!line.startsWith('{')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'step_finish') spend.push({ ms: e.timestamp, usd: stepCost(results.model, e.part?.tokens) });
        if (e.type !== 'tool_use' || !obs[name]) continue;
        const out = String(e.part?.state?.output ?? '');
        const combat = [...out.matchAll(/^Name: \S+ \(Combat (\d+)\)/gm)].at(-1)?.[1];
        const weapon = [...out.matchAll(/^## Combat Style\nWeapon: (.+)$/gm)].at(-1)?.[1];
        const deaths = (out.match(/Oh dear,? you are dead/gi) ?? []).length;
        if (combat || weapon || deaths) {
            obs[name].push({ ms: e.part?.state?.time?.end ?? e.timestamp, combat: combat ? Number(combat) : undefined, weapon, deaths });
        }
    }
}
for (const n of team) obs[n].sort((a, b) => a.ms - b.ms);
spend.sort((a, b) => a.ms - b.ms);

// ---------- per-frame stats ----------
const times: number[] = [];
for (let t = startMs; t <= endMs; t += intervalMs) times.push(t);
const summaries = times.map(t => scoreRun(kills, team, startMs, t));
const uniques = unique ? times.map(t => scoreUnique(kills, team, startMs, t)) : [];
const scores = unique ? uniques.map(u => u.score) : summaries.map(s => s.score);
const scoreMax = Math.max(1, ...scores) * 1.1;
const teamSet = new Set(team.map(t => t.toLowerCase()));
const credited = kills.filter(k => k.killer && teamSet.has(k.killer.toLowerCase()) && Date.parse(k.ts) >= startMs);
const npc = displayName;
const agentOf = (killer: string | null) => team.find(n => n.toLowerCase() === killer?.toLowerCase()) ?? '?';

// Notable moments for the panel's feed: score records, deaths and weapon changes.
const events: Array<{ ms: number; text: string; scoreType?: string | null }> = [];
if (unique) {
    // Every kill that raised the score: a new enemy, or a higher level of one.
    const best = new Map<string, number>();
    for (const k of [...credited].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
        const name = npc(k.npcName), prev = best.get(name);
        if (Date.parse(k.ts) > endMs || (prev !== undefined && k.combatLevel <= prev)) continue;
        best.set(name, k.combatLevel);
        const gain = Math.log1p(Math.max(0, k.combatLevel)) - (prev === undefined ? 0 : Math.log1p(Math.max(0, prev)));
        events.push({ ms: Date.parse(k.ts), text: `${agentOf(k.killer)}: ${prev === undefined ? 'new' : 'higher'} ${name} (L${k.combatLevel}) +${gain.toFixed(2)}` });
    }
}
summaries.forEach((s, i) => {
    if (unique) return;
    if (i && s.score > scores[i - 1] && s.bestType) {
        const lvl = s.distinctNpcs.find(d => d.npcName === s.bestType!.npcName)?.combatLevel;
        events.push({ ms: times[i], text: `score ${s.score.toFixed(2)} via ${npc(s.bestType.npcName)} (L${lvl})`, scoreType: s.bestType.npcName });
    }
});
for (const name of team) {
    let weapon: string | undefined;
    for (const o of obs[name]) {
        for (let d = 0; d < o.deaths; d++) events.push({ ms: o.ms, text: `${name} died` });
        if (o.weapon && weapon && o.weapon !== weapon) events.push({ ms: o.ms, text: o.weapon === 'Unarmed' ? `${name} unarmed` : `${name} wields ${o.weapon}` });
        if (o.weapon) weapon = o.weapon;
    }
}
events.sort((a, b) => a.ms - b.ms);

function mmss(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Last 5 events up to t, newest first; successive records on the same NPC type show only the latest. */
function feedAt(t: number) {
    const shown: typeof events = [];
    for (const e of events) {
        if (e.ms > t) break;
        const prev = shown.findLastIndex(x => x.scoreType !== undefined);
        if (e.scoreType !== undefined && prev >= 0 && shown[prev].scoreType === e.scoreType) shown.splice(prev, 1);
        shown.push(e);
    }
    return shown.slice(-5).reverse().map(e => ({ at: mmss(e.ms - startMs), text: e.text }));
}

function stateAt(i: number) {
    const t = times[i];
    const summary = summaries[i];
    const bt = summary.bestType;
    const btLevel = bt ? summary.distinctNpcs.find(d => d.npcName === bt.npcName)?.combatLevel : undefined;
    const u = unique ? uniques[i] : null;
    const agents = team.map(name => {
        const seen = obs[name].filter(o => o.ms <= t);
        const lastState = seen.findLast(o => o.combat !== undefined);
        const mine = credited.filter(k => k.killer!.toLowerCase() === name.toLowerCase() && Date.parse(k.ts) <= t);
        const last = mine.at(-1);
        return {
            name,
            frame: frameAt(name, t),
            combat: seen.findLast(o => o.combat !== undefined)?.combat ?? null,
            weapon: seen.findLast(o => o.weapon !== undefined)?.weapon ?? null,
            // Combat and weapon are only as fresh as the agent's last execute_code world state.
            staleMin: lastState && t - lastState.ms > STALE_MS ? Math.floor((t - lastState.ms) / 60_000) : null,
            deaths: seen.reduce((a, o) => a + o.deaths, 0),
            kills: mine.length,
            enemies: u ? u.uniqueByAgent[name] : null,
            lastKill: last ? `${npc(last.npcName)} (L${last.combatLevel})` : null,
            lastKillAgo: last ? mmss(t - Date.parse(last.ts)) : null
        };
    });
    const best = summary.bestKill;
    return {
        header: `${runTag} · ${modelName} · ${team.length} agent${team.length > 1 ? 's' : ''}`,
        clock: `${mmss(t - startMs)} / ${mmss(endMs - startMs)}`,
        score: scores[i].toFixed(2),
        scoreSub: u
            ? (u.enemies.length ? `${u.enemies.length} enem${u.enemies.length === 1 ? 'y' : 'ies'} · level sum ${u.levelSum} · score = Σ ln(1 + level)` : 'no kills yet')
            : bt ? `${npc(bt.npcName)} (L${btLevel}) · top-3 avg of ${bt.kills} kill${bt.kills === 1 ? '' : 's'}` : 'no kills yet',
        footer: [
            `spend $${spend.filter(s => s.ms <= t).reduce((a, s) => a + s.usd, 0).toFixed(2)}`,
            u ? `${u.totalKills} kills (${u.nonScoringKills} non-scoring)` : `${summary.totalKills} kills`,
            u ? `overlap ${u.overlap.length}` : best ? `best single kill: ${npc(best.npcName)} ${best.value.toFixed(1)} by ${agentOf(best.killer)}` : null
        ].filter(Boolean).join('  ·  '),
        enemies: u ? u.enemies.map(e => ({ text: `${e.name} L${e.level}`, by: Object.keys(e.byAgent).map(n => n[0]).join('+') })) : null,
        agents,
        events: feedAt(t),
        curve: scores.slice(0, i + 1),
        total: times.length,
        scoreMax
    };
}

// ---------- render ----------
const cols = 2, rows = Math.ceil((team.length + 1) / cols);
/** No spare cell beside the last bot: the panel takes the whole bottom row. */
const widePanel = team.length % cols === 0;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; color: #ddd; font: 15px/1.35 system-ui, sans-serif; }
  #grid { display: grid; grid-template-columns: repeat(${cols}, ${W}px); grid-auto-rows: ${H}px; width: ${cols * W}px; }
  .cell { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  .cell img { width: ${W}px; height: ${H}px; display: block; }
  .tag { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,.7); color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 14px; }
  #panel { background: #161616; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; }
  #main, #side { display: contents; }
  #footer { order: 1; }
  #panel.wide { grid-column: 1 / -1; width: auto; flex-direction: row; gap: 32px; }
  #panel.wide #main, #panel.wide #side { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
  #enemies { columns: 2; font-size: 14px; }
  #enemies div { padding: 1px 0; break-inside: avoid; }
  #enemies span { color: #888; margin-left: 6px; font-size: 12px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; }
  #header { font-weight: 600; font-size: 17px; }
  #clock { font: 600 22px ui-monospace, Consolas, monospace; color: #9ecbff; }
  .label { color: #888; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  #score { font: 700 54px/1 ui-monospace, Consolas, monospace; color: #a5d6a7; }
  #scoreSub { color: #bbb; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; color: #888; font-weight: 500; font-size: 12px; padding: 2px 6px 4px 0; }
  td { padding: 4px 6px 4px 0; border-top: 1px solid #2c2c2c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 190px; }
  th.n { text-align: right; }
  td.n { text-align: right; font-family: ui-monospace, Consolas, monospace; }
  .muted { color: #888; }
  #events { font-size: 13px; }
  #events div { padding: 2px 0; color: #ccc; }
  #events span { color: #888; font-family: ui-monospace, Consolas, monospace; margin-right: 8px; }
  #footer { color: #aaa; font-size: 13px; margin-top: auto; }
</style></head><body><div id="grid">
${team.map((n, i) => `<div class="cell"><img id="img${i}"><div class="tag" id="tag${i}">${n}</div></div>`).join('')}
<div class="cell${widePanel ? ' wide' : ''}" id="panel"><div id="main">
  <div class="row"><div id="header"></div><div id="clock"></div></div>
  <div class="row"><div><div class="label">Team score</div><div id="score"></div></div>
    <canvas id="curve" width="420" height="78"></canvas></div>
  <div id="scoreSub"></div>
  <table><thead><tr><th>Agent</th><th class="n">Combat</th><th>Weapon</th><th class="n">Kills</th>${unique ? '<th class="n">Enemies</th>' : ''}<th class="n">Deaths</th><th>Last kill</th></tr></thead><tbody id="rows"></tbody></table>
  <div id="footer"></div></div><div id="side">
  ${unique ? '<div><div class="label">Enemies killed</div><div id="enemies"></div></div>' : ''}
  <div><div class="label">Recent</div><div id="events"></div></div>
</div></div></div>
<script>
window.render = async (s) => {
  const loads = [];
  s.agents.forEach((a, i) => {
    const img = document.getElementById('img' + i);
    if (a.frame && img.getAttribute('src') !== a.frame) { img.src = a.frame; loads.push(img.decode().catch(() => {})); }
    document.getElementById('tag' + i).textContent = a.name + (a.combat && a.staleMin === null ? ' · cb ' + a.combat : '');
  });
  for (const id of ['header', 'clock', 'score', 'scoreSub', 'footer']) document.getElementById(id).textContent = s[id];
  const rows = document.getElementById('rows');
  rows.replaceChildren(...s.agents.map(a => {
    const tr = document.createElement('tr');
    const old = a.staleMin === null ? '' : ' muted';
    const cells = [[a.name], [a.combat ?? '?', 'n' + old], [(a.weapon ?? '?') + (old ? ' · ' + a.staleMin + 'm old' : ''), old], [a.kills, 'n'], ...(a.enemies === null ? [] : [[a.enemies, 'n']]), [a.deaths, 'n'],
      [a.lastKill ? a.lastKill + ' · ' + a.lastKillAgo + ' ago' : '-', a.lastKill ? '' : 'muted']];
    cells.forEach(([c, cls]) => { const td = document.createElement('td'); td.textContent = c; if (cls) td.className = cls; tr.append(td); });
    return tr;
  }));
  if (s.enemies) document.getElementById('enemies').replaceChildren(...s.enemies.map(e => {
    const d = document.createElement('div'), b = document.createElement('span');
    b.textContent = e.by; d.append(e.text, b); return d;
  }));
  document.getElementById('events').replaceChildren(...s.events.map(e => {
    const d = document.createElement('div'), t = document.createElement('span');
    t.textContent = e.at; d.append(t, e.text); return d;
  }));
  const cv = document.getElementById('curve'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.strokeStyle = '#2c2c2c'; g.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
  const x = i => 1 + (cv.width - 2) * i / Math.max(1, s.total - 1);
  const y = v => cv.height - 2 - (cv.height - 4) * v / s.scoreMax;
  g.beginPath(); g.moveTo(x(0), y(0));
  s.curve.forEach((v, i) => { g.lineTo(x(i), y(i ? s.curve[i - 1] : 0)); g.lineTo(x(i), y(v)); });
  g.lineTo(x(s.curve.length - 1), cv.height - 1); g.lineTo(x(0), cv.height - 1); g.closePath();
  g.fillStyle = 'rgba(165,214,167,.18)'; g.fill();
  g.beginPath(); g.moveTo(x(0), y(0));
  s.curve.forEach((v, i) => { g.lineTo(x(i), y(i ? s.curve[i - 1] : 0)); g.lineTo(x(i), y(v)); });
  g.strokeStyle = '#a5d6a7'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#9ecbff'; g.fillRect(x(s.curve.length - 1) - 1, 0, 2, cv.height);
  g.fillStyle = '#888'; g.font = '11px system-ui'; g.fillText(s.scoreMax.toFixed(0), 5, 13);
  await Promise.all(loads);
};
</script></body></html>`;

const work = mkdtempSync(join(tmpdir(), 'rb-grid-'));
try {
    writeFileSync(join(work, 'grid.html'), html);
    // Software rendering: with the GPU on (Windows/ANGLE), each screenshot waits on a GPU
    // readback and takes ~1.4s; without it ~0.07s.
    const browser = await puppeteer.launch({ headless: true, args: ['--allow-file-access-from-files', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: cols * W, height: rows * H });
    await page.goto(pathToFileURL(join(work, 'grid.html')).href);
    if (stillMinute !== null) {
        const i = Math.min(times.length - 1, Math.round(stillMinute * 60_000 / intervalMs));
        await page.evaluate(s => (window as any).render(s), stateAt(i));
        const still = join(runDir, `grid-still-${stillMinute}m.jpg`);
        await page.screenshot({ path: still as `${string}.jpeg`, type: 'jpeg', quality: 90 });
        console.log(still);
    }
    for (let i = 0; stillMinute === null && i < times.length; i++) {
        await page.evaluate(s => (window as any).render(s), stateAt(i));
        await page.screenshot({ path: join(work, `f-${String(i).padStart(5, '0')}.jpg`) as `${string}.jpeg`, type: 'jpeg', quality: 88 });
        if (i % 100 === 0) console.log(`frame ${i}/${times.length}`);
    }
    await browser.close();
    if (stillMinute === null) {
        const out = join(runDir, 'timelapse-grid.mp4');
        const r = spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(work, 'f-%05d.jpg'),
            '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
        if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(0, 300)}`);
        console.log(out);
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
