// Where each agent's time went: waiting on the model vs running tools, from the OpenCode transcripts.
//
//   bun bench/timing.ts runs/<run> [runs/<run> ...] [--write]   # --write adds `timing` to results.json
//
// OpenCode logs step_start when the model's first token arrives, not when the request goes out, so a
// turn's model time runs from the previous step_finish to the turn's first tool start (or to its
// step_finish when it calls no tool). Each transcript's first turn starts at its first event, which
// misses that one request's wait. Tool time is the union of the turn's tool intervals.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

export type AgentTiming = {
    agent: string;
    turns: number;
    gameCalls: number;
    modelSeconds: number;
    toolSeconds: number;
    gameToolSeconds: number;
    medianModelSecondsPerTurn: number | null;
    gameCallsPerMinute: number;
};
export type RunTiming = {
    agents: AgentTiming[];
    modelShare: number; // share of model + tool time spent waiting on the model, whole team
    medianModelSecondsPerTurn: number | null;
    gameCallsPerMinute: number; // whole team
};

const GAME_TOOL = 'rs-agent_execute_code';
const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function unionMs(spans: Array<[number, number]>): number {
    let total = 0, end = -Infinity;
    for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
        if (b <= end) continue;
        total += b - Math.max(a, end);
        end = b;
    }
    return total;
}

/** null when the run has no OpenCode transcripts (e.g. the claude backend). */
export function runTiming(runDir: string, minutes: number): RunTiming | null {
    const files = readdirSync(runDir).filter(f => /^agent-.+-\d+\.jsonl$/.test(f));
    const byAgent = new Map<string, { turns: number[]; game: number; tool: number; gameTool: number }>();
    let sawSteps = false;
    for (const f of files.sort((a, b) => parseInt(a.match(/-(\d+)\.jsonl$/)![1]!) - parseInt(b.match(/-(\d+)\.jsonl$/)![1]!))) {
        const agent = f.replace(/^agent-/, '').replace(/-\d+\.jsonl$/, '');
        const acc = byAgent.get(agent) ?? { turns: [], game: 0, tool: 0, gameTool: 0 };
        byAgent.set(agent, acc);
        let prevEnd: number | null = null;
        let firstTool: number | null = null;
        let spans: Array<[number, number]> = [];
        let gameSpans: Array<[number, number]> = [];
        for (const line of readFileSync(join(runDir, f), 'utf-8').split('\n')) {
            if (!line.trim()) continue;
            let e: any;
            try { e = JSON.parse(line); } catch { continue; }
            prevEnd ??= e.timestamp;
            if (e.type === 'step_start') {
                sawSteps = true;
                firstTool = null;
                spans = [];
                gameSpans = [];
            } else if (e.type === 'tool_use') {
                const t = e.part?.state?.time;
                if (t?.start && t?.end) {
                    firstTool = Math.min(firstTool ?? t.start, t.start);
                    spans.push([t.start, t.end]);
                    if (e.part.tool === GAME_TOOL) gameSpans.push([t.start, t.end]);
                }
                if (e.part?.tool === GAME_TOOL) acc.game++;
            } else if (e.type === 'step_finish') {
                acc.turns.push(Math.max(0, (firstTool ?? e.timestamp) - prevEnd!) / 1000);
                acc.tool += unionMs(spans) / 1000;
                acc.gameTool += unionMs(gameSpans) / 1000;
                prevEnd = e.timestamp;
            }
        }
    }
    if (!sawSteps) return null;
    const agents: AgentTiming[] = [...byAgent].sort(([a], [b]) => a.localeCompare(b)).map(([agent, a]) => ({
        agent,
        turns: a.turns.length,
        gameCalls: a.game,
        modelSeconds: round(a.turns.reduce((s, x) => s + x, 0)),
        toolSeconds: round(a.tool),
        gameToolSeconds: round(a.gameTool),
        medianModelSecondsPerTurn: median(a.turns) === null ? null : round(median(a.turns)!),
        gameCallsPerMinute: round(a.game / minutes, 2)
    }));
    const model = agents.reduce((s, a) => s + a.modelSeconds, 0), tool = agents.reduce((s, a) => s + a.toolSeconds, 0);
    const allTurns = [...byAgent.values()].flatMap(a => a.turns);
    return {
        agents,
        modelShare: round(model / Math.max(1e-9, model + tool), 3),
        medianModelSecondsPerTurn: median(allTurns) === null ? null : round(median(allTurns)!),
        gameCallsPerMinute: round(agents.reduce((s, a) => s + a.gameCalls, 0) / minutes, 2)
    };
}

if (import.meta.main) {
    const write = process.argv.includes('--write');
    for (const dir of process.argv.slice(2).filter(a => a !== '--write')) {
        const resultsPath = join(dir, 'results.json');
        const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf-8')) : null;
        const t = runTiming(dir, results?.minutes ?? 15);
        if (!t) { console.log(`${basename(dir)}: no OpenCode transcripts`); continue; }
        console.log(`${basename(dir)}: model ${Math.round(t.modelShare * 100)}% of active time, median ${t.medianModelSecondsPerTurn}s/turn, ${t.gameCallsPerMinute} game calls/min`
            + (results?.score !== undefined ? ` | score ${results.score.toFixed(2)}` : ''));
        for (const a of t.agents)
            console.log(`  ${a.agent.padEnd(8)} turns ${String(a.turns).padStart(3)}  game calls ${String(a.gameCalls).padStart(3)}  model ${String(a.modelSeconds).padStart(6)}s  tools ${String(a.toolSeconds).padStart(6)}s  median ${a.medianModelSecondsPerTurn}s/turn`);
        if (write && results) writeFileSync(resultsPath, JSON.stringify({ ...results, timing: t }, null, 2));
    }
}
