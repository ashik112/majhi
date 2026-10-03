"""Generate the painted river banks for the majhi.dev hero.

Writes site/assets/h-bank-far.svg and site/assets/h-bank-near.svg: an inked
bank shape covered in hand-painted grass blades and rickshaw-style flowers.
Seeded, so reruns produce the same files.

    python3 scripts/site-banks.py
"""
import math
import random
from pathlib import Path

W = 3440
H = 100
INK = "#120e0b"
OUT = Path(__file__).resolve().parent.parent / "site" / "assets"


def edge(rnd, base, amp, step=60):
    """Wavy top edge as a list of (x, y), soft mounds of varied width."""
    pts, x = [], -40
    while x < W + 80:
        pts.append((x, base + rnd.uniform(-amp, amp)))
        x += step * rnd.uniform(0.7, 1.4)
    return pts


def edge_y(pts, x):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0)
            t = (1 - math.cos(t * math.pi)) / 2
            return y0 + (y1 - y0) * t
    return pts[-1][1]


def edge_path(pts):
    d = f"M{pts[0][0]:.0f} {H + 10} L{pts[0][0]:.0f} {pts[0][1]:.0f}"
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        mx = (x0 + x1) / 2
        d += f" C{mx:.0f} {y0:.0f} {mx:.0f} {y1:.0f} {x1:.0f} {y1:.0f}"
    return d + f" L{pts[-1][0]:.0f} {H + 10} Z"


def blade(rnd, x, y, h, w, lean):
    """One tapered brush stroke that bows the way it leans."""
    tx, ty = x + lean * h, y - h
    bow = lean * h * 0.45
    return (f"M{x - w / 2:.0f} {y:.0f}Q{x - w / 2 + bow:.0f} {y - h * 0.6:.0f} {tx:.0f} {ty:.0f}"
            f"Q{x + w / 2 + bow:.0f} {y - h * 0.6:.0f} {x + w / 2:.0f} {y:.0f}Z")


def tuft(rnd, x, y, size, n):
    """A clump of blades fanning out from one root, tallest in the middle."""
    out = []
    for i in range(n):
        t = i / (n - 1) - 0.5 if n > 1 else 0
        h = size * (1 - abs(t) * 0.7) * rnd.uniform(0.8, 1.1)
        out.append(blade(rnd, x + t * size * 0.35, y, h, max(2, size * 0.2), t * 0.9 + rnd.uniform(-0.12, 0.12)))
    return "".join(out)


def daisy(x, y, r, petals, fill, eye, rot):
    ink = f' stroke="{INK}" stroke-width="{r * 0.14:.1f}"' if r >= 6 else ""
    out = []
    for i in range(petals):
        a = rot + i * 2 * math.pi / petals
        px, py = x + math.cos(a) * r * 0.62, y + math.sin(a) * r * 0.62
        out.append(f'<ellipse cx="{px:.1f}" cy="{py:.1f}" rx="{r * 0.5:.1f}" ry="{r * 0.24:.1f}" '
                   f'transform="rotate({math.degrees(a):.0f} {px:.1f} {py:.1f})"/>')
    return (f'<g fill="{fill}"{ink}>{"".join(out)}</g>'
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r * 0.28:.1f}" fill="{eye}"/>')


def lily(x, y, r, rot):
    """Yellow star lily with red throat, as on rickshaw panels."""
    pts = []
    for i in range(10):
        a = rot + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.38
        pts.append(f"{x + math.cos(a) * rr:.1f},{y + math.sin(a) * rr:.1f}")
    ink = f' stroke="{INK}" stroke-width="{r * 0.12:.1f}" stroke-linejoin="round"' if r >= 6 else ""
    return (f'<polygon points="{" ".join(pts)}" fill="#f6c419"{ink}/>'
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r * 0.26:.1f}" fill="#d42a3c"/>')


def bank(name, seed, base, amp, blade_size, flower_size, flowers, density):
    rnd = random.Random(seed)
    top = edge(rnd, base, amp)
    layers = {"#0b6236": [], "#14874a": [], "#3fae55": [], "#a6d84a": []}

    # back row: dark tufts along the edge, poking over the ink line
    x = 0
    while x < W:
        layers["#0b6236"].append(tuft(rnd, x, edge_y(top, x) + 6, blade_size * rnd.uniform(0.8, 1.15), rnd.randint(3, 5)))
        x += blade_size * rnd.uniform(0.5, 0.9)
    # body: scattered tufts in mid greens, smaller toward the back
    for _ in range(int(W / blade_size * density)):
        x = rnd.uniform(0, W)
        y0 = edge_y(top, x) + 10
        y = rnd.uniform(y0, H + 6)
        depth = (y - y0) / max(1, H - y0)
        col = rnd.choice(["#14874a", "#14874a", "#0b6236", "#3fae55"])
        layers[col].append(tuft(rnd, x, y, blade_size * (0.65 + 0.45 * depth), rnd.randint(3, 5)))
    # light catches the front of a few clumps
    for _ in range(int(W / blade_size / 5)):
        x = rnd.uniform(0, W)
        y = rnd.uniform(edge_y(top, x) + 14, H)
        layers["#a6d84a"].append(tuft(rnd, x, y, blade_size * 0.6, 3))

    blooms = []
    for _ in range(flowers):
        x = rnd.uniform(10, W - 10)
        y = rnd.uniform(edge_y(top, x) + flower_size * 0.6, H - flower_size * 0.5)
        r = flower_size * rnd.uniform(0.7, 1.1)
        kind = rnd.random()
        rot = rnd.uniform(0, math.pi)
        if kind < 0.5:
            blooms.append(daisy(x, y, r, 6, "#fffdf6", "#f6c419", rot))
        elif kind < 0.75:
            blooms.append(daisy(x, y, r * 0.8, 5, "#d42a3c", "#f6c419", rot))
        elif kind < 0.9:
            blooms.append(lily(x, y, r * 1.1, rot))
        else:
            blooms.append(daisy(x, y, r * 0.75, 5, "#ef6aa6", "#fffdf6", rot))

    body = [f'<path d="{edge_path(top)}" fill="#1e9a50" stroke="{INK}" stroke-width="4" stroke-linejoin="round"/>']
    for col, paths in layers.items():
        body.append(f'<path fill="{col}" d="{"".join(paths)}"/>')
    body.extend(blooms)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -{blade_size:.0f} {W} {H + blade_size:.0f}" '
           f'width="{W}" height="{H + blade_size:.0f}">{"".join(body)}</svg>\n')
    (OUT / name).write_text(svg)
    print(name, len(svg) // 1024, "KB")


bank("h-bank-far.svg", seed=7, base=14, amp=5, blade_size=13, flower_size=5, flowers=110, density=1.6)
bank("h-bank-near.svg", seed=11, base=26, amp=9, blade_size=24, flower_size=10, flowers=80, density=4.5)
