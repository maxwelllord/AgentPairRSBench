// Scoring for the combat benchmark (two modes: strongest NPC, and unique enemies further down). Pure functions over kill-ledger entries
// (one JSON line per NPC death, written by the engine at NPC_DEL), plus a CLI
// to rescore a finished run:  bun bench/score.ts runs/<runId>
//
// The ledger keeps raw facts (level, hp, time-to-kill, damage split), so any
// formula here can be changed and old runs rescored.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { displayName } from './npc-names';

export type Kill = {
    ts: string;
    tick: number;
    npcId: number;
    npcName: string | null;
    combatLevel: number;
    maxHp: number;
    /** ticks from the start of the engagement to death */
    ttkTicks: number | null;
    /** player damage dealt during that engagement; absent in ledgers from before it was recorded */
    engagementDamage?: number | null;
    killer: string | null;
    contributors: Array<{ username: string | null; damage: number }>;
    x: number;
    z: number;
    level: number;
};

/** One game tick is 0.6s of game time regardless of NODE_TICKRATE, so scores don't depend on server speed. */
export const SECONDS_PER_TICK = 0.6;
/** DPS (hp per game second) at which a kill is worth half its combat level. */
export const REFERENCE_DPS = 1;

export function ttkSeconds(k: Kill): number | null {
    return k.ttkTicks === null || k.ttkTicks === undefined ? null : k.ttkTicks * SECONDS_PER_TICK;
}

/**
 * Damage per game second against this NPC during the killing engagement. Uses the damage
 * actually dealt in that engagement (capped at max hp), so finishing off a wounded npc
 * isn't credited as a full-hp kill. Older ledgers without it fall back to max hp.
 */
export function dps(k: Kill): number | null {
    const t = ttkSeconds(k);
    if (t === null) return null;
    const damage = k.engagementDamage == null ? k.maxHp : Math.min(k.engagementDamage, k.maxHp);
    return damage / Math.max(t, SECONDS_PER_TICK);
}

/**
 * dps / (dps + REFERENCE_DPS), i.e. damage / (damage + seconds to kill) at the default reference.
 * Normalised by damage so big monsters aren't penalised just for taking longer:
 * 0.5 dps -> 0.33, 1 dps -> 0.5, 2 dps -> 0.67, 4 dps -> 0.8.
 */
export function speedFactor(k: Kill): number {
    const d = dps(k);
    return d === null ? 1 : d / (d + REFERENCE_DPS);
}

/** Primary value of a kill: combat level scaled by how efficiently it died. */
export function killValue(k: Kill): number {
    return Math.max(0, k.combatLevel) * speedFactor(k);
}

/** How many kills of one NPC type are averaged; missing kills count as 0. */
export const TOP_N = 3;

/**
 * Value of an NPC type for a team: the mean of its TOP_N best kill values, with
 * missing kills as 0. One lucky kill is worth a third; farming for an outlier
 * helps far less than with a single best kill. The run score is the best type.
 */
export function typeValues(kills: Kill[]): Map<number, { npcName: string | null; value: number; kills: number }> {
    const byType = new Map<number, Kill[]>();
    for (const k of kills) {
        if (!byType.has(k.npcId)) byType.set(k.npcId, []);
        byType.get(k.npcId)!.push(k);
    }
    const out = new Map<number, { npcName: string | null; value: number; kills: number }>();
    for (const [id, ks] of byType) {
        const top = ks.map(killValue).sort((a, b) => b - a).slice(0, TOP_N);
        out.set(id, { npcName: ks[0].npcName, value: top.reduce((a, b) => a + b, 0) / TOP_N, kills: ks.length });
    }
    return out;
}

function bestType(kills: Kill[]): { npcName: string | null; value: number; kills: number } | null {
    let best: { npcName: string | null; value: number; kills: number } | null = null;
    for (const t of typeValues(kills).values()) if (!best || t.value > best.value) best = t;
    return best;
}

/** Alternative formulas kept for comparison in results. */
export const altValues = {
    bestSingleKill: killValue,
    combatLevel: (k: Kill) => Math.max(0, k.combatLevel),
    levelPlusHalfHp: (k: Kill) => Math.max(0, k.combatLevel) + k.maxHp / 2,
    levelTimeOnly: (k: Kill) => {
        const t = ttkSeconds(k);
        return Math.max(0, k.combatLevel) * (t === null ? 1 : 60 / (60 + t));
    }
};

type ScoredKill = Kill & { value: number; ttkSeconds: number | null; dps: number | null; minutesIn: number };

export type ScoreSummary = {
    score: number;
    /** NPC type that produced the score (mean of its top-3 kill values) */
    bestType: { npcName: string | null; value: number; kills: number } | null;
    /** single most valuable kill (diagnostic; not the score) */
    bestKill: ScoredKill | null;
    alt: Record<keyof typeof altValues, number>;
    totalKills: number;
    killsByAgent: Record<string, number>;
    /** best-so-far score at each minute mark, for anytime curves */
    bestOverTime: Array<{ minute: number; best: number }>;
    distinctNpcs: Array<{ npcName: string | null; combatLevel: number; maxHp: number; count: number; fastestTtkSeconds: number | null }>;
};

/** Kills credited to a team member inside the run window. */
function creditedKills(kills: Kill[], team: string[], startMs: number, endMs: number): Kill[] {
    const members = new Set(team.map(t => t.toLowerCase()));
    return kills.filter(k => {
        const t = Date.parse(k.ts);
        return k.killer && members.has(k.killer.toLowerCase()) && t >= startMs && t <= endMs;
    });
}

export function scoreRun(kills: Kill[], team: string[], startMs: number, endMs: number): ScoreSummary {
    const credited = creditedKills(kills, team, startMs, endMs);

    let best: ScoredKill | null = null;
    const killsByAgent: Record<string, number> = Object.fromEntries(team.map(t => [t, 0]));
    const distinct = new Map<number, ScoreSummary['distinctNpcs'][number]>();
    for (const k of credited) {
        const value = killValue(k);
        if (!best || value > best.value) {
            best = { ...k, value, ttkSeconds: ttkSeconds(k), dps: dps(k), minutesIn: (Date.parse(k.ts) - startMs) / 60_000 };
        }
        const agent = team.find(t => t.toLowerCase() === k.killer!.toLowerCase())!;
        killsByAgent[agent]++;
        const d = distinct.get(k.npcId) ?? { npcName: k.npcName, combatLevel: k.combatLevel, maxHp: k.maxHp, count: 0, fastestTtkSeconds: null };
        d.count++;
        const t = ttkSeconds(k);
        if (t !== null && (d.fastestTtkSeconds === null || t < d.fastestTtkSeconds)) d.fastestTtkSeconds = t;
        distinct.set(k.npcId, d);
    }

    const alt = Object.fromEntries(
        Object.entries(altValues).map(([name, f]) => [name, credited.length ? Math.max(...credited.map(f)) : 0])
    ) as ScoreSummary['alt'];

    const totalMinutes = Math.ceil((endMs - startMs) / 60_000);
    const bestOverTime: ScoreSummary['bestOverTime'] = [];
    for (let m = 1; m <= totalMinutes; m++) {
        const cutoff = startMs + m * 60_000;
        const upTo = credited.filter(k => Date.parse(k.ts) <= cutoff);
        bestOverTime.push({ minute: m, best: bestType(upTo)?.value ?? 0 });
    }

    const topType = bestType(credited);
    return {
        score: topType?.value ?? 0,
        bestType: topType,
        bestKill: best,
        alt,
        totalKills: credited.length,
        killsByAgent,
        bestOverTime,
        distinctNpcs: [...distinct.values()].sort((a, b) => b.combatLevel - a.combatLevel)
    };
}

// ---------- unique-enemies mode ----------
// Score = sum over every distinct enemy the team killed of ln(1 + its combat level). An enemy is
// its in-game name, so Goblin level 2 and level 5 are one enemy, valued at the highest level
// killed. The log keeps breadth meaningful: one lesser demon (82) is worth ~6 chickens, not 82.

export function uniqueValue(combatLevel: number): number {
    return Math.log1p(Math.max(0, combatLevel));
}

export type UniqueEnemy = {
    name: string;
    /** highest combat level of this enemy the team killed */
    level: number;
    value: number;
    kills: number;
    firstAt: string;
    firstBy: string;
    byAgent: Record<string, number>;
};

export type UniqueSummary = {
    score: number;
    /** plain sum of the enemies' levels, for comparison */
    levelSum: number;
    enemies: UniqueEnemy[];
    totalKills: number;
    killsByAgent: Record<string, number>;
    /** distinct enemies each agent killed at least once */
    uniqueByAgent: Record<string, number>;
    /** enemies killed by more than one agent (duplicated effort, or deliberate) */
    overlap: string[];
    /** kills that added no new enemy and no higher level of one (training, loot, accidents) */
    nonScoringKills: number;
    scoreOverTime: Array<{ minute: number; score: number }>;
    /** when the final score was reached (tiebreak: earlier is better) */
    finalScoreAt: string | null;
    /** every kill that raised the score (a new enemy, or a higher level of one), in order, with where it happened */
    scoringKills: ScoringKill[];
};

export type ScoringKill = {
    ts: string;
    agent: string;
    enemy: string;
    level: number;
    /** score added by this kill */
    gain: number;
    /** world tile; plane 0 is ground level, underground areas sit at z + 6400 */
    x: number;
    z: number;
    plane: number;
};

export function scoreUnique(kills: Kill[], team: string[], startMs: number, endMs: number): UniqueSummary {
    const credited = creditedKills(kills, team, startMs, endMs).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const agentOf = (k: Kill) => team.find(t => t.toLowerCase() === k.killer!.toLowerCase())!;
    const enemies = new Map<string, UniqueEnemy>();
    const killsByAgent: Record<string, number> = Object.fromEntries(team.map(t => [t, 0]));
    let nonScoringKills = 0;
    let finalScoreAt: string | null = null;
    const scoringKills: ScoringKill[] = [];
    const scored = (k: Kill, agent: string, enemy: string, gain: number) =>
        scoringKills.push({ ts: k.ts, agent, enemy, level: k.combatLevel, gain, x: k.x, z: k.z, plane: k.level });
    for (const k of credited) {
        const name = displayName(k.npcName);
        const agent = agentOf(k);
        killsByAgent[agent]++;
        let e = enemies.get(name);
        if (!e) {
            e = { name, level: k.combatLevel, value: uniqueValue(k.combatLevel), kills: 0, firstAt: k.ts, firstBy: agent, byAgent: {} };
            enemies.set(name, e);
            if (e.value > 0) {
                finalScoreAt = k.ts;
                scored(k, agent, name, e.value);
            } else nonScoringKills++;
        } else if (k.combatLevel > e.level) {
            const before = e.value;
            e.level = k.combatLevel;
            e.value = uniqueValue(k.combatLevel);
            finalScoreAt = k.ts;
            scored(k, agent, name, e.value - before);
        } else {
            nonScoringKills++;
        }
        e.kills++;
        e.byAgent[agent] = (e.byAgent[agent] ?? 0) + 1;
    }

    const scoreAt = (cutoff: number) => {
        const best = new Map<string, number>();
        for (const k of credited) {
            if (Date.parse(k.ts) > cutoff) break;
            const name = displayName(k.npcName);
            best.set(name, Math.max(best.get(name) ?? 0, k.combatLevel));
        }
        return [...best.values()].reduce((a, l) => a + uniqueValue(l), 0);
    };
    const scoreOverTime: UniqueSummary['scoreOverTime'] = [];
    for (let m = 1; m <= Math.ceil((endMs - startMs) / 60_000); m++) scoreOverTime.push({ minute: m, score: scoreAt(startMs + m * 60_000) });

    const list = [...enemies.values()].sort((a, b) => b.level - a.level);
    return {
        score: list.reduce((a, e) => a + e.value, 0),
        levelSum: list.reduce((a, e) => a + Math.max(0, e.level), 0),
        enemies: list,
        totalKills: credited.length,
        killsByAgent,
        uniqueByAgent: Object.fromEntries(team.map(t => [t, list.filter(e => e.byAgent[t]).length])),
        overlap: list.filter(e => Object.keys(e.byAgent).length > 1).map(e => e.name),
        nonScoringKills,
        scoreOverTime,
        finalScoreAt,
        scoringKills
    };
}

export function parseLedger(text: string): Kill[] {
    return text
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as Kill);
}

if (import.meta.main) {
    const runDir = process.argv[2];
    if (!runDir || !existsSync(join(runDir, 'results.json'))) {
        console.error('Usage: bun bench/score.ts <runDir>   (dir containing results.json and kills.jsonl)');
        process.exit(1);
    }
    const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf-8'));
    const kills = parseLedger(readFileSync(join(runDir, 'kills.jsonl'), 'utf-8'));
    const score = results.mode === 'unique' ? scoreUnique : scoreRun;
    const summary = score(kills, results.team, Date.parse(results.startedAt), Date.parse(results.endedAt));
    console.log(JSON.stringify(summary, null, 2));
}
