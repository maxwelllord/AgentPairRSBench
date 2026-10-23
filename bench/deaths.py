# Where each agent died, for the map timelapses.
#
# How many: the world state after every execute_code call reports "Life: N (M respawns observed)", the
# game's own running count, so each rise in M between two game calls is that many deaths.
# Where: a death shows in positions.jsonl as a hop to near the Lumbridge respawn tile. Agents run
# ~40 tiles/s at 8x speed, so by the next sample (0.25-0.3 s) they can already be 10-13 tiles from
# it; running itself covers at most ~12 tiles a sample, so a hop of 16+ tiles is a respawn. The
# deaths in a call's window go to its biggest such hops. After an agent's last call nothing is
# counted, so there only unmistakable hops count: 40+ tiles, or up from a dungeon.
#   python bench/deaths.py runs/<a> [runs/<b> ...]   ->  deaths per agent, as on the results page
import glob, json, math, os, re, sys
from datetime import datetime

RESPAWN = (3221, 3218)  # death.rs2: 0_50_50_21_18
GAME_TOOL = 'rs-agent_execute_code'


def _jump(a, b):
    """Size of the hop between two samples: tiles, with dungeons (z + 6400) counted as far away."""
    return math.dist(a[1:3], b[1:3]) if (a[2] >= 6400) == (b[2] >= 6400) and a[3] == b[3] else 1e9


def find_deaths(run, name, track, t0=0.0):
    """Indices into track [(t ms - t0, x, z, plane)] of the samples just after each death."""
    cands = [i for i in range(1, len(track)) if track[i][3] == 0 and abs(track[i][1] - RESPAWN[0]) <= 15
             and abs(track[i][2] - RESPAWN[1]) <= 15 and _jump(track[i - 1], track[i]) >= 16]
    calls = []  # (end ms - t0, respawns observed so far)
    for f in glob.glob(os.path.join(run, f'agent-{name}-*.jsonl')):
        for line in open(f, encoding='utf-8'):
            if GAME_TOOL not in line or '"tool_use"' not in line:
                continue
            j = json.loads(line)
            if j.get('type') == 'tool_use' and j['part'].get('tool') == GAME_TOOL:
                counts = re.findall(r'\((\d+) respawns? observed\)', j['part']['state'].get('output') or '')
                calls.append((j['timestamp'] - t0, int(counts[-1]) if counts else None))
    calls.sort()
    # Windows open at the last call that reported the count: a call made while dead shows
    # "Status: DEAD" instead, so the respawn may land before the call after it.
    found, known_at, seen = set(), -1e18, 0
    for end, count in calls:
        if count is None:
            continue
        if count > seen:
            window = [i for i in cands if known_at - 3000 < track[i][0] <= end + 1000 and i not in found]
            window.sort(key=lambda i: -_jump(track[i - 1], track[i]))
            found.update(window[:count - seen])
            seen = count
        known_at = end
    found.update(i for i in cands if track[i][0] > known_at and _jump(track[i - 1], track[i]) >= 40)
    return sorted(found)


def run_deaths(run):
    """{agent: number of deaths} for one run dir, from its positions.jsonl and transcripts."""
    tracks = {}
    for line in open(os.path.join(run, 'positions.jsonl'), encoding='utf-8'):
        if line.strip():
            s = json.loads(line)
            t = datetime.fromisoformat(s['ts'].replace('Z', '+00:00')).timestamp() * 1000
            for p in s['players']:
                tracks.setdefault(p['name'], []).append((t, p['x'], p['z'], p['level']))
    return {n: len(find_deaths(run, n, tr)) for n, tr in sorted(tracks.items())}


if __name__ == '__main__':
    for run in sys.argv[1:]:
        d = run_deaths(run)
        print(os.path.basename(os.path.normpath(run)), ' + '.join(str(v) for v in d.values()), d)
