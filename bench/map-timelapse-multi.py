# Several runs raced on one world map (underground positions drawn at the surface above, hollow dots): each run is a team in its own colour (red, blue, green, ...),
# its clock starting at 0:00, with fading trails, an X per death, and a marker plus rising "+gain"
# label for every kill that raised that team's score. Same drawing as map-timelapse.py.
#   python bench/map-timelapse-multi.py --out runs/compare/<name> --title "..." runs/<a> runs/<b> ...
#   ->  <out>/map-timelapse.mp4   (1 game second per frame; needs the engine up for the map base)
# --zoom 3 renders the map 3x larger and follows the explored area instead: the camera starts close
# in and eases out as the agents spread, never closer than the base's own resolution, never back in.
import argparse, json, math, os, subprocess, sys
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # bench/ (python -I leaves it off)
from deaths import find_deaths  # noqa: E402

FPS = 30
STEP = 1.0              # game seconds per video frame
TRAIL = 45.0            # seconds of trail behind each agent
POPUP = 45.0            # seconds a scoring kill's label stays up
JUMP = 60               # tiles between consecutive samples treated as a discontinuity
TEAM_COLORS = [(235, 64, 64), (60, 130, 255), (40, 200, 90), (240, 200, 40), (200, 90, 230)]

ap = argparse.ArgumentParser()
ap.add_argument('runs', nargs='+')
ap.add_argument('--out', required=True)
ap.add_argument('--title', default='')
ap.add_argument('--zoom', type=float, default=0, help='map resolution multiple for the following camera (e.g. 3); 0 = fixed full view')
args = ap.parse_args()
runs = [r.rstrip('/\\') for r in args.runs]
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(args.out, exist_ok=True)


def ms(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000


def tint(c, k):  # mix towards white by k
    return tuple(int(v + (255 - v) * k) for v in c)


# The map base frames every position of every run: map-base.ts reads <out>/positions.jsonl.
with open(os.path.join(args.out, 'positions.jsonl'), 'w', encoding='utf-8') as fh:
    for r in runs:
        fh.write(open(os.path.join(r, 'positions.jsonl'), encoding='utf-8').read())
OW, OH = 1920, 1080  # video size
size = [str(int(OW * args.zoom)), str(int(OH * args.zoom))] if args.zoom else []
subprocess.run(['bun', os.path.join(here, 'map-base.ts'), args.out, *size], check=True)
view = json.load(open(os.path.join(args.out, 'map-base.json')))
W, H = view['width'], view['height']  # map base size; equals the video size without --zoom


def remap_z(z):
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
    mx = x - view['mapOriginX'] + 0.5
    my = view['mapOriginZ'] + view['mapHeight'] - rz - 0.5
    return (view['sWid'] * (mx - view['left']) / (view['right'] - view['left']),
            view['sHei'] * (my - view['top']) / (view['bottom'] - view['top']))


# Per team: times are ms since that run's start, so all teams share one clock.
teams = []
for i, r in enumerate(runs):
    res = json.load(open(os.path.join(r, 'results.json'), encoding='utf-8'))
    t0 = ms(res['startedAt'])
    tracks = {}
    for line in open(os.path.join(r, 'positions.jsonl'), encoding='utf-8'):
        if line.strip():
            s = json.loads(line)
            for p in s['players']:
                tracks.setdefault(p['name'], []).append((ms(s['ts']) - t0, p['x'], p['z'], p['level']))
    deaths = {n: find_deaths(r, n, tr, t0) for n, tr in tracks.items()}
    tag = next((p for p in os.path.basename(r).split('-') if p.startswith('r') and p[1:].isdigit()), os.path.basename(r))
    color = TEAM_COLORS[i % len(TEAM_COLORS)]
    names = sorted(tracks)
    teams.append(dict(tag=tag, color=color, final=res['score'], tracks=tracks, names=names, deaths=deaths,
                      shade={n: tint(color, 0.45 * k) for k, n in enumerate(names)},
                      scoring=[dict(k, t=ms(k['ts']) - t0) for k in res.get('scoringKills', [])],
                      cursor={n: 0 for n in names}))
    print(tag, 'deaths:', {n: len(d) for n, d in deaths.items()}, 'score', round(res['score'], 2))
minutes = json.load(open(os.path.join(runs[0], 'results.json'), encoding='utf-8')).get('minutes', 15)
t_end = max(tr[-1][0] for T in teams for tr in T['tracks'].values())

font_path = 'C:/Windows/Fonts/arialbd.ttf'
big = ImageFont.truetype(font_path, 30)
small = ImageFont.truetype(font_path, 20)
tiny = ImageFont.truetype(font_path, 16)
base = Image.alpha_composite(Image.open(os.path.join(args.out, 'map-base.png')).convert('RGBA'), Image.new('RGBA', (W, H), (0, 0, 0, 60))).convert('RGB')

out = os.path.join(args.out, 'map-timelapse.mp4')
ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{OW}x{OH}', '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], stdin=subprocess.PIPE)


def draw_diamond(d, p, color):
    s = 7
    d.polygon([(p[0], p[1] - s), (p[0] + s, p[1]), (p[0], p[1] + s), (p[0] - s, p[1])], fill=color + (255,), outline=(0, 0, 0, 255), width=2)


def draw_x(d, p, color):
    s = 9
    for w, c in ((8, (0, 0, 0, 230)), (4, color + (255,))):
        d.line([(p[0] - s, p[1] - s), (p[0] + s, p[1] + s)], fill=c, width=w)
        d.line([(p[0] - s, p[1] + s), (p[0] + s, p[1] - s)], fill=c, width=w)


# Camera (--zoom): centre and width in map-base pixels, easing towards a box around everything
# seen so far. Without --zoom it is the whole base, 1:1.
seen = [math.inf, math.inf, -math.inf, -math.inf]
cam = [W / 2, H / 2, W]
EASE = 0.06  # fraction of the remaining distance the camera covers per frame


def see(x, z):
    if p := to_px(x, z):
        seen[:] = [min(seen[0], p[0]), min(seen[1], p[1]), max(seen[2], p[0]), max(seen[3], p[1])]


def aim():
    x0, y0, x1, y1 = seen
    pad = 0.15 * max(x1 - x0, (y1 - y0) * OW / OH) + 80 * args.zoom
    w = min(W, max(x1 - x0 + 2 * pad, (y1 - y0 + 2 * pad) * OW / OH, OW))
    return (x0 + x1) / 2, (y0 + y1) / 2, w


def px(x, z):  # world tile -> video pixel
    p = to_px(x, z)
    if p is None:
        return None
    k = OW / cam[2]
    return ((p[0] - cam[0]) * k + OW / 2, (p[1] - cam[1]) * k + OH / 2)


for T in teams:
    for n in T['names']:
        see(*T['tracks'][n][0][1:3])
if args.zoom:
    cam[:] = aim()

frame_t = 0.0
while frame_t <= t_end + 1:
    layer = Image.new('RGBA', (OW, OH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for T in teams:
        for n in T['names']:
            tr = T['tracks'][n]
            while T['cursor'][n] + 1 < len(tr) and tr[T['cursor'][n] + 1][0] <= frame_t:
                T['cursor'][n] += 1
                see(*tr[T['cursor'][n]][1:3])
    if args.zoom:
        tx, ty, tw = aim()
        cam[2] = max(cam[2], cam[2] + (tw - cam[2]) * EASE)  # only ever zooms out
        cam[0] += (tx - cam[0]) * EASE
        cam[1] += (ty - cam[1]) * EASE
        ch = cam[2] * OH / OW  # keep the view inside the base
        cam[0] = min(max(cam[0], cam[2] / 2), W - cam[2] / 2)
        cam[1] = min(max(cam[1], ch / 2), H - ch / 2)
    for T in teams:  # kill markers and deaths stay on the map
        for k in T['scoring']:
            if k['t'] <= frame_t and (p := px(k['x'], k['z'])):
                draw_diamond(d, p, T['color'])
        for n in T['names']:
            for j in T['deaths'][n]:
                if T['tracks'][n][j][0] <= frame_t and (p := px(*T['tracks'][n][j - 1][1:3])):
                    draw_x(d, p, T['color'])
    for T in teams:  # fading trails
        for n in T['names']:
            tr, dead, color = T['tracks'][n], set(T['deaths'][n]), T['shade'][n]
            j = T['cursor'][n]
            while j > 0 and tr[j][0] > frame_t - TRAIL * 1000:
                a, b = tr[j - 1], tr[j]
                if j not in dead and a[3] == b[3] and math.dist(a[1:3], b[1:3]) <= JUMP and (pa := px(*a[1:3])) and (pb := px(*b[1:3])):
                    fade = max(0.0, 1 - (frame_t - b[0]) / (TRAIL * 1000))
                    d.line([pa, pb], fill=(0, 0, 0, int(140 * fade)), width=7)
                    d.line([pa, pb], fill=color + (int(255 * fade),), width=4)
                j -= 1
    labels = []
    for T in teams:  # agent dots, labelled "r047 A"
        for n in T['names']:
            cur = T['tracks'][n][T['cursor'][n]]
            if cur[0] <= frame_t and (p := px(*cur[1:3])):
                if cur[2] >= 6400:  # underground: hollow dot
                    d.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=(0, 0, 0, 255), outline=T['shade'][n] + (255,), width=4)
                else:
                    d.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=T['shade'][n] + (255,), outline=(255, 255, 255, 255), width=3)
                ly = p[1] - 11
                while any(abs(p[0] - lx) < 70 and abs(ly - y) < 18 for lx, y in labels):
                    ly += 18
                labels.append((p[0], ly))
                d.text((p[0] + 12, ly), f"{T['tag']} {n[0]}", font=tiny, fill=T['shade'][n] + (255,), stroke_width=3, stroke_fill=(0, 0, 0, 255))
    popups = []
    for T in teams:  # rising labels for recent scoring kills
        for k in T['scoring']:
            age = (frame_t - k['t']) / 1000
            if 0 <= age < POPUP and (p := px(k['x'], k['z'])):
                fade = 1 - max(0.0, age - POPUP * 0.6) / (POPUP * 0.4)
                y = p[1] - 22 - 30 * age / POPUP
                while any(abs(p[0] - x) < 160 and abs(y - py) < 24 for x, py in popups):
                    y -= 24
                popups.append((p[0], y))
                text = f"{k['enemy']} L{k['level']}  +{k['gain']:.2f}"
                w = d.textlength(text, font=small)
                d.text((p[0] - w / 2, y - 12), text, font=small, fill=T['color'] + (int(255 * fade),), stroke_width=3, stroke_fill=(0, 0, 0, int(255 * fade)))
    # HUD: clock, title, then one row per team with its live score and deaths
    secs = frame_t / 1000
    rows_y = 92 if args.title else 64
    d.rounded_rectangle([16, 16, 440, rows_y + 32 * len(teams) + 8], radius=10, fill=(0, 0, 0, 175))
    d.text((32, 24), f'{int(secs // 60):02d}:{int(secs % 60):02d} / {minutes:02d}:00', font=big, fill=(255, 255, 255, 255))
    if args.title:
        d.text((32, 62), args.title, font=small, fill=(200, 200, 200, 255))
    for k, T in enumerate(sorted(teams, key=lambda T: -sum(s['gain'] for s in T['scoring'] if s['t'] <= frame_t))):
        y = rows_y + 32 * k
        score = sum(s['gain'] for s in T['scoring'] if s['t'] <= frame_t)
        n_dead = sum(1 for n in T['names'] for j in T['deaths'][n] if T['tracks'][n][j][0] <= frame_t)
        d.ellipse([34, y + 3, 50, y + 19], fill=T['color'] + (255,), outline=(255, 255, 255, 255), width=2)
        d.text((62, y), f"{T['tag']}", font=small, fill=(255, 255, 255, 255))
        d.text((130, y), f'{score:6.2f}', font=small, fill=(255, 230, 120, 255))
        d.text((230, y), f'{n_dead} death{"" if n_dead == 1 else "s"}', font=small, fill=(200, 200, 200, 255))
    ch = cam[2] * OH / OW
    frame = base.resize((OW, OH), Image.BILINEAR, box=(cam[0] - cam[2] / 2, cam[1] - ch / 2, cam[0] + cam[2] / 2, cam[1] + ch / 2))
    frame.paste(layer, (0, 0), layer)
    ff.stdin.write(frame.tobytes())
    frame_t += STEP * 1000

ff.stdin.close()
ff.wait()
print(out)
