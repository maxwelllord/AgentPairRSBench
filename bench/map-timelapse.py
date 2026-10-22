# World-map timelapse of a run: each agent's recorded position (positions.jsonl, from r037 on)
# over the game's own map, with a fading trail, an X where each death happened (deaths.py), and a marker plus
# a rising "+gain" label for every kill that raised the team score (scoringKills).
#   python bench/map-timelapse.py runs/<run>  ->  <run>/map-timelapse.mp4   (1 game second per frame)
# The background comes from bench/map-base.ts (needs the engine running), rendered once per run.
import glob, json, math, os, re, subprocess, sys
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # bench/ (python -I leaves it off)
from deaths import find_deaths  # noqa: E402

FPS = 30
STEP = 1.0              # game seconds per video frame
TRAIL = 45.0            # seconds of trail behind each agent
POPUP = 60.0            # seconds a scoring kill's label stays up (2 s of video)
JUMP = 60               # tiles between consecutive samples treated as a discontinuity
COLORS = [(77, 163, 255), (255, 140, 40), (60, 220, 140), (240, 90, 200), (255, 220, 60)]

run = sys.argv[1].rstrip('/\\')
here = os.path.dirname(os.path.abspath(__file__))
if not os.path.exists(os.path.join(run, 'map-base.json')):
    subprocess.run(['bun', os.path.join(here, 'map-base.ts'), run], check=True)
view = json.load(open(os.path.join(run, 'map-base.json')))
W, H = view['width'], view['height']


def ms(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000


def remap_z(z):
    # MapView.remapZ: raw mapsquare row -> unified map row, or None outside every band
    for b in view['bands']:
        if b['from'] <= z >> 6 <= b['to']:
            return ((z >> 6) + b['offset'] << 6) | (z & 63)
    return None


def to_px(x, z):
    if z >= 6400:  # underground: draw at the surface spot above (dungeons sit 6400 tiles north)
        z -= 6400
    rz = remap_z(z)
    if rz is None:
        return None
    mx = x - view['mapOriginX'] + 0.5                              # tile centre; a tile's row is mapY - 1
    my = view['mapOriginZ'] + view['mapHeight'] - rz - 0.5
    return (view['sWid'] * (mx - view['left']) / (view['right'] - view['left']),
            view['sHei'] * (my - view['top']) / (view['bottom'] - view['top']))


# Per agent: [(t ms, x, z, level)] in time order
tracks = {}
for line in open(os.path.join(run, 'positions.jsonl'), encoding='utf-8'):
    if line.strip():
        s = json.loads(line)
        for p in s['players']:
            tracks.setdefault(p['name'], []).append((ms(s['ts']), p['x'], p['z'], p['level']))
names = sorted(tracks)
t0 = min(tr[0][0] for tr in tracks.values())
t_end = max(tr[-1][0] for tr in tracks.values())


# Deaths: see deaths.py (game respawn counter for how many, respawn hops for where).
deaths = {n: find_deaths(run, n, tracks[n]) for n in names}
print('deaths:', {n: len(d) for n, d in deaths.items()})

results = json.load(open(os.path.join(run, 'results.json'), encoding='utf-8')) if os.path.exists(os.path.join(run, 'results.json')) else {}
# Kills that raised the score; runs scored before scoringKills existed are rescored (print-only).
scoring = results.get('scoringKills')
if scoring is None and results.get('mode') == 'unique':
    scoring = json.loads(subprocess.run(['bun', os.path.join(here, 'score.ts'), run], check=True, capture_output=True, text=True).stdout)['scoringKills']
scoring = [dict(k, t=ms(k['ts'])) for k in (scoring or [])]
color_of = dict(zip(names, COLORS))
model = (results.get('model') or '').split('/')[-1]
tag = re.search(r'r\d{3}', os.path.basename(run))
title = '  ·  '.join(x for x in (model, tag.group(0) if tag else '') if x)
minutes = results.get('minutes', 15)

font_path = 'C:/Windows/Fonts/arialbd.ttf'
big = ImageFont.truetype(font_path, 30)
small = ImageFont.truetype(font_path, 20)
base = Image.alpha_composite(Image.open(os.path.join(run, 'map-base.png')).convert('RGBA'), Image.new('RGBA', (W, H), (0, 0, 0, 50)))

out = os.path.join(run, 'map-timelapse.mp4')
ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], stdin=subprocess.PIPE)


def draw_diamond(d, p, color):
    s = 7
    d.polygon([(p[0], p[1] - s), (p[0] + s, p[1]), (p[0], p[1] + s), (p[0] - s, p[1])], fill=color + (255,), outline=(0, 0, 0, 255), width=2)


def draw_x(d, p, color):
    s = 9
    for w, c in ((8, (0, 0, 0, 230)), (4, color + (255,))):
        d.line([(p[0] - s, p[1] - s), (p[0] + s, p[1] + s)], fill=c, width=w)
        d.line([(p[0] - s, p[1] + s), (p[0] + s, p[1] - s)], fill=c, width=w)


cursor = {n: 0 for n in names}   # index of the latest sample at or before the frame time
frame_t = t0
while frame_t <= t_end + 1:
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for n in names:
        tr = tracks[n]
        while cursor[n] + 1 < len(tr) and tr[cursor[n] + 1][0] <= frame_t:
            cursor[n] += 1
    for k in scoring:
        if k['t'] <= frame_t and (p := to_px(k['x'], k['z'])):
            draw_diamond(d, p, color_of.get(k['agent'], (255, 255, 255)))
    for n, color in zip(names, COLORS):
        for j in deaths[n]:
            if tracks[n][j][0] <= frame_t and (p := to_px(*tracks[n][j - 1][1:3])):
                draw_x(d, p, color)
    for n, color in zip(names, COLORS):
        tr, dead = tracks[n], set(deaths[n])
        j = cursor[n]
        while j > 0 and tr[j][0] > frame_t - TRAIL * 1000:
            a, b = tr[j - 1], tr[j]
            if j not in dead and a[3] == b[3] and math.dist(a[1:3], b[1:3]) <= JUMP and (pa := to_px(*a[1:3])) and (pb := to_px(*b[1:3])):
                fade = max(0.0, 1 - (frame_t - b[0]) / (TRAIL * 1000))
                d.line([pa, pb], fill=(0, 0, 0, int(140 * fade)), width=7)
                d.line([pa, pb], fill=color + (int(255 * fade),), width=4)
            j -= 1
    labels = []  # label anchors placed so far; agents on the same spot get stacked names
    for n, color in zip(names, COLORS):
        cur = tracks[n][cursor[n]]
        if cur[0] <= frame_t and (p := to_px(*cur[1:3])):
            d.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=color + (255,), outline=(255, 255, 255, 255), width=3)
            ly = p[1] - 12
            while any(abs(p[0] - lx) < 90 and abs(ly - y) < 22 for lx, y in labels):
                ly += 22
            labels.append((p[0], ly))
            d.text((p[0] + 12, ly), n, font=small, fill=color + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    popups = []  # rising labels for recent scoring kills, stacked when they overlap
    for k in scoring:
        age = (frame_t - k['t']) / 1000
        if 0 <= age < POPUP and (p := to_px(k['x'], k['z'])):
            fade = 1 - max(0.0, age - POPUP * 0.6) / (POPUP * 0.4)
            y = p[1] - 22 - 30 * age / POPUP
            while any(abs(p[0] - x) < 160 and abs(y - py) < 26 for x, py in popups):
                y -= 26
            popups.append((p[0], y))
            text = f"{k['enemy']} L{k['level']}  +{k['gain']:.2f}"
            w = d.textlength(text, font=small)
            d.text((p[0] - w / 2, y - 12), text, font=small, fill=color_of.get(k['agent'], (255, 255, 255)) + (int(255 * fade),),
                   stroke_width=3, stroke_fill=(0, 0, 0, int(255 * fade)))
    score_now = sum(k['gain'] for k in scoring if k['t'] <= frame_t)
    secs = (frame_t - t0) / 1000
    rows = 3 if title else 2
    d.rounded_rectangle([16, 16, 360, 30 + 36 + 28 * (rows - 1) + 30 * len(names)], radius=10, fill=(0, 0, 0, 170))
    d.text((32, 24), f'{int(secs // 60):02d}:{int(secs % 60):02d} / {minutes:02d}:00', font=big, fill=(255, 255, 255, 255))
    d.text((32, 62), f'Score {score_now:.2f}', font=small, fill=(255, 230, 120, 255))
    if title:
        d.text((32, 90), title, font=small, fill=(200, 200, 200, 255))
    for k, (n, color) in enumerate(zip(names, COLORS)):
        y = 34 + 36 + 28 * (rows - 1) + 30 * k
        n_dead = sum(1 for j in deaths[n] if tracks[n][j][0] <= frame_t)
        d.ellipse([34, y + 3, 50, y + 19], fill=color + (255,), outline=(255, 255, 255, 255), width=2)
        d.text((62, y), f'{n}   {n_dead} death{"" if n_dead == 1 else "s"}', font=small, fill=(255, 255, 255, 255))
    ff.stdin.write(Image.alpha_composite(base, layer).convert('RGB').tobytes())
    frame_t += STEP * 1000

ff.stdin.close()
ff.wait()
print(out)
