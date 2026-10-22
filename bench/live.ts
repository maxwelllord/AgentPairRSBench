// Live agent feed for live.html: tails each agent's latest transcript and the team
// notes, and writes <runDir>/agents.js every few seconds. Exits once results.json exists.
//
//   bun bench/live.ts <runDir> [notesPath]

import { readdirSync, existsSync, openSync, readSync, fstatSync, closeSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const [runDir, notesPath] = process.argv.slice(2);
const TAIL_BYTES = 256 * 1024;
const MAX_EVENTS = 14;

function tail(path: string, bytes: number): string {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf-8');
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // drop a partial first line
    } finally {
        closeSync(fd);
    }
}

function oneLine(s: unknown, max: number): string {
    return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

type FeedEvent = { t: string; kind: 'think' | 'tool' | 'error'; text: string; ok?: boolean };

function summarize(path: string): FeedEvent[] {
    const events: FeedEvent[] = [];
    for (const line of tail(path, TAIL_BYTES).split('\n')) {
        if (!line.startsWith('{')) continue;
        let e: any;
        try { e = JSON.parse(line); } catch { continue; }
        const t = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : '';
        if (e.type === 'text' && e.part?.text?.trim()) {
            events.push({ t, kind: 'think', text: oneLine(e.part.text, 400) });
        } else if (e.type === 'tool_use') {
            const s = e.part?.state ?? {};
            const input = s.input ?? {};
            const what = input.code ?? input.command ?? input.filePath ?? input.pattern ?? JSON.stringify(input);
            const result = s.status === 'error' ? s.error : s.output;
            events.push({ t, kind: 'tool', ok: s.status !== 'error', text: `${e.part.tool}: ${oneLine(what, 160)}  ->  ${oneLine(result, 160)}` });
        } else if (e.type === 'error') {
            events.push({ t, kind: 'error', text: oneLine(e.error?.data?.message ?? e.error?.name, 200) });
        }
    }
    return events.slice(-MAX_EVENTS);
}

function snapshot() {
    const files = readdirSync(runDir).filter(f => /^agent-.+-\d+\.jsonl$/.test(f));
    const byAgent = new Map<string, { file: string; n: number }>();
    for (const f of files) {
        const [, name, n] = f.match(/^agent-(.+)-(\d+)\.jsonl$/)!;
        if (!byAgent.has(name) || Number(n) > byAgent.get(name)!.n) byAgent.set(name, { file: f, n: Number(n) });
    }
    const agents: Record<string, { launch: number; idleSec: number; events: FeedEvent[] }> = {};
    for (const [name, { file, n }] of byAgent) {
        const path = join(runDir, file);
        agents[name] = { launch: n, idleSec: Math.round((Date.now() - statSync(path).mtimeMs) / 1000), events: summarize(path) };
    }
    let notes = '';
    if (notesPath && existsSync(notesPath)) {
        const full = readFileSync(notesPath, 'utf-8');
        notes = full.length > 4000 ? '...\n' + full.slice(-4000) : full;
    }
    writeFileSync(join(runDir, 'agents.js'), `window.AGENTS=${JSON.stringify({ agents, notes })};`);
}

for (;;) {
    try {
        snapshot();
    } catch (err) {
        console.error(`live feed: ${err}`);
    }
    if (existsSync(join(runDir, 'results.json'))) break;
    await new Promise(r => setTimeout(r, 3000));
}
