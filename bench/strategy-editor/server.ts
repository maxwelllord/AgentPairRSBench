// Strategy editor: place tasks for each agent on the world map and save them as a strategy file
// for `run.ts --strategy`. Static map (map-base.png/json, rendered once by map-base.ts), so the
// engine doesn't need to be up.
//   bun bench/strategy-editor/server.ts   ->  http://localhost:7790
// Saves strategies/<name>.json (for re-editing) and strategies/<name>.txt (the prompt text).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const HERE = import.meta.dir;
const ROOT = join(HERE, '..', '..');
const STRATEGIES = join(ROOT, 'strategies');
const WIKI_NPCS = join(ROOT, 'rs-sdk', 'wiki', 'npcs');
const PORT = parseInt(process.env.PORT ?? '7790');
mkdirSync(STRATEGIES, { recursive: true });

// Every NPC the wiki knows, with its combat level and surface spawn samples.
type Npc = { name: string; level: number; spawns: Array<[number, number]> };
const npcs: Npc[] = [];
for (const file of readdirSync(WIKI_NPCS).filter(f => f.endsWith('.md'))) {
    const md = readFileSync(join(WIKI_NPCS, file), 'utf-8');
    const name = md.match(/^# (.+)$/m)?.[1]?.trim();
    const locations = md.split(/^## Locations$/m)[1]?.split(/^## /m)[0] ?? '';
    const spawns = [...locations.matchAll(/\((\d+), (\d+)\)/g)].map(m => [+m[1], +m[2]] as [number, number]).filter(([, z]) => z < 6400);
    if (name && spawns.length) npcs.push({ name, level: parseInt(md.match(/\*\*Combat Level\*\* \| (\d+)/)?.[1] ?? '0'), spawns });
}
npcs.sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level);

const safeName = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
const file = (path: string, type: string) => new Response(Bun.file(path), { headers: { 'Content-Type': type } });

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === '/') return file(join(HERE, 'index.html'), 'text/html; charset=utf-8');
        if (path === '/map-base.png') return file(join(HERE, 'map-base.png'), 'image/png');
        if (path === '/map-base.json') return file(join(HERE, 'map-base.json'), 'application/json');
        if (path === '/npcs.json') return Response.json(npcs);
        if (path === '/favicon.ico') return new Response(null, { status: 204 });
        if (path === '/api/strategies') {
            return Response.json(readdirSync(STRATEGIES).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort());
        }
        const m = path.match(/^\/api\/strategies\/([^/]+)$/);
        if (m) {
            const name = safeName(decodeURIComponent(m[1]));
            if (!name) return new Response('names are letters, digits, - and _', { status: 400 });
            const json = join(STRATEGIES, `${name}.json`);
            if (req.method === 'GET') return existsSync(json) ? file(json, 'application/json') : new Response('not found', { status: 404 });
            if (req.method === 'POST') {
                const body = (await req.json()) as { doc: unknown; text: string };
                writeFileSync(json, JSON.stringify(body.doc, null, 2) + '\n');
                writeFileSync(join(STRATEGIES, `${name}.txt`), body.text.trimEnd() + '\n');
                return Response.json({ saved: `strategies/${name}.txt` });
            }
        }
        return new Response('not found', { status: 404 });
    }
});
console.log(`strategy editor: http://localhost:${PORT}  (${npcs.length} NPCs from the wiki; saving to ${STRATEGIES})`);
