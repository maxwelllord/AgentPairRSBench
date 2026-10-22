// In-game display names for NPCs, keyed by the debugname the kill ledger records
// (e.g. man, man2 and man3 are all "Man"). Read from the content .npc configs.

import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const CONTENT = resolve(import.meta.dir, '..', 'rs-sdk', 'server', 'content');

let cache: Map<string, string> | null = null;

export function npcDisplayNames(): Map<string, string> {
    if (cache) return cache;
    cache = new Map();
    for (const file of readdirSync(CONTENT, { recursive: true }) as string[]) {
        if (!file.endsWith('.npc')) continue;
        let debugname: string | null = null;
        for (const line of readFileSync(join(CONTENT, file), 'utf-8').split(/\r?\n/)) {
            const header = line.match(/^\[(.+)\]\s*$/);
            if (header) debugname = header[1];
            else if (debugname && line.startsWith('name=')) cache.set(debugname, line.slice(5).trim());
        }
    }
    return cache;
}

/** Display name for a ledger npcName, falling back to the debugname itself. */
export function displayName(npcName: string | null): string {
    if (!npcName) return '?';
    return npcDisplayNames().get(npcName) ?? npcName;
}
