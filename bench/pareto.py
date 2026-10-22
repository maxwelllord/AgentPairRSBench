# Score vs cost for the 2-agent, 15-minute unique-enemies runs, with the cost-efficiency
# Pareto frontier.  python bench/pareto.py  ->  runs/pareto-unique15.png
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# (model, cost $, score, cost range if uncertain)
RUNS = [
    ('Sol', 1.22, 76.80, None),
    ('Gemini 4 Argon', 1.73, 55.82, None),
    ('HY4 Preview', 0.59, 49.58, None),
    ('GPT-6 Luna', 0.23, 31.27, None),
    ('Opus 5.5', 2.84, 60.56, None),
    ('Sonnet 5.5', 1.64, 30.54, None),
    ('Muse Wonder', 3.50, 34.57, None),
    ('Gemini 3.8 Flash', 2.01, 19.21, None),
    ('Qwen3.8 Flash', 0.077, 15.18, None),
    ('Nemotron 3 Ultra', 2.69, 14.24, None),
    ('GLM-5.3', 0.30, 11.73, (0.30, 1.18)),  # OpenCode estimate .. Z.AI list price
    ('DeepSeek V4.1 Flash', 0.09, 29.03, None),  # mean of r039, r040; r019 excluded (MCP crash)
    ('Haiku 5.5', 0.065, 10.06, None),
    ('MiMo v2.6 Flash', 0.21, 8.83, None),
    ('Gemma 4 31B', 0.71, 8.83, None),
    ('Solar Mini 4', 0.35, 0.0, None),
]

frontier, best = [], -1
for r in sorted(RUNS, key=lambda r: r[1]):
    if r[2] > best:
        frontier.append(r)
        best = r[2]
on = {r[0] for r in frontier}

INK, MUTED, GRID, ACCENT, OFF = '#1f2328', '#6e7781', '#e6e8eb', '#2f6fde', '#a8b0b8'
fig, ax = plt.subplots(figsize=(9, 5.6), dpi=150)
ax.set_xscale('log')
ax.plot([r[1] for r in frontier], [r[2] for r in frontier], color=ACCENT, lw=2, zorder=2, label='Pareto frontier')
for name, cost, score, rng in RUNS:
    if rng:
        ax.plot(rng, [score, score], color=OFF, lw=2, solid_capstyle='round', zorder=1)
    ax.scatter(cost, score, s=64, color=ACCENT if name in on else OFF, edgecolor='white', linewidth=2, zorder=3)
    offset = {'GLM-5.3': (-4, 8), 'DeepSeek V4.1 Flash': (-8, -3)}.get(name, (8, -3))
    ax.annotate(name, (cost, score), xytext=offset, textcoords='offset points', ha='right' if offset[0] == -8 else 'left',
                fontsize=9, color=INK if name in on else MUTED)
ax.scatter([], [], s=64, color=OFF, label='dominated')
ax.set_xlabel('Run cost (USD, log scale)', color=MUTED)
ax.set_ylabel('Score: Σ ln(1 + level) over distinct enemies', color=MUTED)
ax.set_title('Unique-enemies bench: 2 agents, 15 min (r021–r040)', color=INK, loc='left', fontsize=11)
ax.set_xticks([0.05, 0.1, 0.2, 0.5, 1, 2, 3])
ax.get_xaxis().set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f'${v:g}'))
ax.grid(True, color=GRID, lw=1)
ax.set_axisbelow(True)
for s in ax.spines.values():
    s.set_visible(False)
ax.tick_params(colors=MUTED, length=0)
ax.set_ylim(-4, 85)
ax.set_xlim(0.03, 4.5)
ax.legend(frameon=False, loc='upper left', fontsize=9)
ax.text(0.99, 0.97, 'GLM bar: cost range (OpenCode estimate to Z.AI list price).\n'
        'One run per model, except DeepSeek: mean of 2 (r019 dropped, its Bravo lost the game tool at 0:24).',
        transform=ax.transAxes, ha='right', va='top', fontsize=7.5, color=MUTED)
fig.tight_layout()
fig.savefig('runs/pareto-unique15.png')
print('runs/pareto-unique15.png')
