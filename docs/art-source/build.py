#!/usr/bin/env python3
"""
Ultimate Legends - artwork generator.

Everything in the launcher's visual identity is drawn here from simple geometry
(parallelograms, discs, halftone dot screens) plus Google Fonts typography.

    python build.py              # write HTML sources to ./html
    python build.py --render     # ...and render every deliverable into the repo
    python build.py --canvas DIR # ...and write Claude Design canvas artboards to DIR

See README.md for details.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
HTML_DIR = HERE / "html"
GAMES_OUT = REPO / "src" / "launcher-ui" / "assets" / "img" / "games"
BRAND_OUT = REPO / "src" / "launcher-ui" / "assets" / "img" / "brand"
APP_RES = REPO / "src" / "launcher" / "resource"

EDGE = os.environ.get(
    "EDGE", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)

FONTS = (
    "https://fonts.googleapis.com/css2?"
    "family=Archivo:wdth,wght@62..125,500..900"
    "&family=IBM+Plex+Mono:wght@500;600&display=block"
)

# --------------------------------------------------------------------------
# Brand palette
# --------------------------------------------------------------------------
INK = "#0C0D12"        # background, near-black with a cold cast
INK_2 = "#16171F"      # raised surface
PAPER = "#F3EEE3"      # warm newsprint white for text
PRIMARY = "#FFC23D"    # Legend Yellow (process-yellow gold)
SECONDARY = "#36C5EE"  # Process Cyan
PRIMARY_DEEP = "#E9A61F"

GAMES = {
    "mua": {
        "title": "Marvel: Ultimate Alliance",
        "accent": "#FF7A3D",  # Flare Orange
        "accent_name": "Flare Orange",
        "motif": "bars",
        "kicker": "MARVEL:",
        "lines": ["ULTIMATE", "ALLIANCE"],
        "logo_line": "ULTIMATE ALLIANCE",
        "logo_size": 160,
        "sub": None,
        "soon": False,
        "concept": "Four rising bars - four heroes charging in formation - with a Ben-Day dot shadow.",
    },
    "mua2": {
        "title": "Marvel: Ultimate Alliance 2",
        "accent": "#6B78FF",  # Cobalt
        "accent_name": "Cobalt",
        "motif": "split",
        "kicker": "MARVEL:",
        "lines": ["ULTIMATE", "ALLIANCE <b>2</b>"],
        "logo_line": "ULTIMATE ALLIANCE <b>2</b>",
        "logo_size": 146,
        "sub": None,
        "soon": False,
        "concept": "A disc split along the diagonal and slid apart - one side solid, one side halftone: two sides.",
    },
    "xml2": {
        "title": "X-Men Legends II: Rise of Apocalypse",
        "accent": "#AD6BFF",  # Eclipse Violet
        "accent_name": "Eclipse Violet",
        "motif": "eclipse",
        "kicker": None,
        "lines": ["X-MEN", "LEGENDS II:"],
        "logo_line": "X-MEN LEGENDS II:",
        "logo_size": 168,
        "sub": "RISE OF APOCALYPSE",
        "soon": False,
        "concept": "A total eclipse: a black sun ringed in violet with a halftone corona and one bright bead.",
    },
    "muac": {
        "title": "Marvel: Ultimate Alliance (2006 PC)",
        "accent": "#2FD4AE",  # Proof Teal
        "accent_name": "Proof Teal",
        "motif": "dots",
        "kicker": "MARVEL:",
        "lines": ["ULTIMATE", "ALLIANCE"],
        "logo_line": "ULTIMATE ALLIANCE",
        "logo_size": 160,
        "sub": "(2006 PC)",
        "soon": True,
        "concept": "Four Ben-Day dots mid-print - one inked, two in halftone, one still a dashed outline: a proof in progress.",
    },
    "xml1": {
        "title": "X-Men Legends",
        "accent": "#FF4D63",  # Dawn Crimson
        "accent_name": "Dawn Crimson",
        "motif": "dawn",
        "kicker": None,
        "lines": ["X-MEN", "LEGENDS"],
        "logo_line": "X-MEN LEGENDS",
        "logo_size": 196,
        "sub": None,
        "soon": True,
        "concept": "A sun rising over the horizon, printed only in halftone - the first Legends, still coming up.",
    },
}

ORDER = ["mua", "mua2", "xml2", "muac", "xml1"]

# The house diagonal: every cut, lean and slide uses this 45-degree "/" direction
# for badges and a 20-degree forward lean for bars.
LEAN = math.tan(math.radians(20))

# --------------------------------------------------------------------------
# SVG helpers
# --------------------------------------------------------------------------
CANVAS_MODE = False  # when True, SVG leaf elements get explicit close tags


def el(tag, **attrs):
    a = " ".join(f'{k.rstrip("_").replace("_", "-")}="{v}"' for k, v in attrs.items())
    return f"<{tag} {a}></{tag}>" if CANVAS_MODE else f"<{tag} {a}/>"


def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def pts(points):
    return " ".join(f"{f(x)},{f(y)}" for x, y in points)


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def smooth(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def halftone(box, field, pitch, angle=45, rmax=None, rmin=0.45):
    """Area-proportional halftone screen over box=(x0,y0,x1,y1).

    field(x, y) -> ink coverage 0..1. Returns concatenated <circle> markup.
    """
    x0, y0, x1, y1 = box
    rmax = rmax if rmax is not None else pitch * 0.58
    a = math.radians(angle)
    ux, uy = math.cos(a), math.sin(a)
    vx, vy = -uy, ux
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = math.hypot(x1 - x0, y1 - y0) / 2
    n = int(half / pitch) + 2
    out = []
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            x = cx + (i * ux + j * vx) * pitch
            y = cy + (i * uy + j * vy) * pitch
            if x < x0 - rmax or x > x1 + rmax or y < y0 - rmax or y > y1 + rmax:
                continue
            v = clamp(field(x, y))
            r = rmax * math.sqrt(v)
            if r < rmin:
                continue
            out.append(el("circle", cx=f(x), cy=f(y), r=f"{r:.2f}"))
    return "".join(out)


def para(x, yb, w, h, lean=LEAN):
    dx = h * lean
    return [(x, yb), (x + w, yb), (x + w + dx, yb - h), (x + dx, yb - h)]


def half_disc_path(cx, cy, r, dx, dy, upper=True):
    """Half of a disc cut through its centre along direction (dx, dy)."""
    p1 = (cx + r * dx, cy + r * dy)
    p2 = (cx - r * dx, cy - r * dy)
    sweep = 0 if upper else 1
    return f"M{f(p1[0])},{f(p1[1])} A{f(r)},{f(r)} 0 0 {sweep} {f(p2[0])},{f(p2[1])} Z"


# --------------------------------------------------------------------------
# Motifs. Each returns SVG markup for a W x H artboard; `ctx` places it.
# --------------------------------------------------------------------------

def motif_bars(g, W, H, ctx):
    acc = g["accent"]
    # four equal bars in echelon: each one a step further forward and higher
    x0, yb, w, gap, h, step = ctx["x0"], ctx["yb"], ctx["w"], ctx["gap"], ctx["h"], ctx["step"]
    sx, sy = ctx["shadow"]
    bars = [para(x0 + i * (w + gap), yb - i * step, w, h) for i in range(4)]
    uid = ctx["uid"]
    clip = "".join(el("polygon", points=pts([(x + sx, y + sy) for x, y in b])) for b in bars)
    bg = halftone((0, 0, W, H), ctx["bg_field"], ctx["pitch"] * 1.35, angle=15)
    shadow = halftone((0, 0, W, H), lambda x, y: 0.42, ctx["pitch"] * 0.62, angle=45)
    solid = "".join(el("polygon", points=pts(b)) for b in bars)
    return (
        f'<defs><clipPath id="{uid}-sh">{clip}</clipPath></defs>'
        f'<g fill="{acc}" opacity="0.2">{bg}</g>'
        f'<g fill="{acc}" clip-path="url(#{uid}-sh)">{shadow}</g>'
        f'<g fill="{acc}">{solid}</g>'
    )


def motif_split(g, W, H, ctx):
    acc = g["accent"]
    cx, cy, r = ctx["cx"], ctx["cy"], ctx["r"]
    uid = ctx["uid"]
    d = (math.cos(math.radians(-45)), math.sin(math.radians(-45)))  # "/" direction
    n = (d[1], -d[0])  # normal pointing up-left
    s, e = ctx["slide"], ctx["sep"]
    ux, uy = cx + s * d[0] + e * n[0], cy + s * d[1] + e * n[1]
    lx, ly = cx - s * d[0] - e * n[0], cy - s * d[1] - e * n[1]
    upper = half_disc_path(ux, uy, r, d[0], d[1], upper=True)
    lower = half_disc_path(lx, ly, r, d[0], d[1], upper=False)

    def field(x, y):
        dist = (x - lx) * -n[0] + (y - ly) * -n[1]  # distance from cut, into lower half
        return 0.95 - 0.8 * (dist / r)

    dots = halftone((lx - r, ly - r, lx + r, ly + r), field, ctx["pitch"], angle=45)
    bg = halftone((0, 0, W, H), ctx["bg_field"], ctx["pitch"] * 1.35, angle=15)
    return (
        f'<defs><clipPath id="{uid}-lo"><path d="{lower}"></path></clipPath></defs>'
        f'<g fill="{acc}" opacity="0.16">{bg}</g>'
        f'<g fill="{acc}" clip-path="url(#{uid}-lo)">{dots}</g>'
        f'<path d="{upper}" fill="{acc}"></path>'
    )


def motif_eclipse(g, W, H, ctx):
    acc = g["accent"]
    cx, cy, r, L = ctx["cx"], ctx["cy"], ctx["r"], ctx["reach"]
    a0 = math.radians(-50)

    def field(x, y):
        dx, dy = x - cx, y - cy
        dist = math.hypot(dx, dy)
        if dist < r:
            return 0
        t = clamp(1 - (dist - r) / L)
        ang = math.atan2(dy, dx)
        bias = 0.5 + 0.5 * math.cos(ang - a0)
        return (t ** 1.7) * (0.35 + 0.75 * bias) * ctx.get("fade", lambda _x, _y: 1)(x, y)

    box = (max(0, cx - r - L), max(0, cy - r - L), min(W, cx + r + L), min(H, cy + r + L))
    corona = halftone(box, field, ctx["pitch"], angle=45)
    bx, by = cx + r * math.cos(a0), cy + r * math.sin(a0)
    rim = ctx["rim"]
    return (
        f'<g fill="{acc}">{corona}</g>'
        + el("circle", cx=f(cx), cy=f(cy), r=f(r + rim), fill=acc)
        + el("circle", cx=f(cx), cy=f(cy), r=f(r), fill=INK)
        + el("circle", cx=f(bx), cy=f(by), r=f(ctx["bead"]), fill=PAPER)
    )


def motif_dots(g, W, H, ctx):
    acc = g["accent"]
    uid = ctx["uid"]
    r = ctx["r"]
    centers = ctx["centers"]
    out = []
    # 1: fully inked
    out.append(el("circle", cx=f(centers[0][0]), cy=f(centers[0][1]), r=f(r), fill=acc))
    # 2, 3: halftone at decreasing coverage
    for k, cov in ((1, 0.62), (2, 0.24)):
        x, y = centers[k]
        out.append(f'<clipPath id="{uid}-d{k}">' + el("circle", cx=f(x), cy=f(y), r=f(r)) + "</clipPath>")
        dots = halftone((x - r, y - r, x + r, y + r), lambda _x, _y, c=cov: c, ctx["pitch"], angle=45)
        out.append(f'<g fill="{acc}" clip-path="url(#{uid}-d{k})">{dots}</g>')
    # 4: not yet printed - dashed outline
    x, y = centers[3]
    sw = ctx["stroke"]
    out.append(
        el("circle", cx=f(x), cy=f(y), r=f(r - sw / 2), fill="none", stroke=acc,
           stroke_width=f(sw), stroke_dasharray=f"{f(sw * 2.2)} {f(sw * 1.8)}")
    )
    bg = halftone((0, 0, W, H), ctx["bg_field"], ctx["pitch"] * 1.35, angle=15)
    return f'<g fill="{acc}" opacity="0.14">{bg}</g>' + "".join(out)


def motif_dawn(g, W, H, ctx):
    acc = g["accent"]
    uid = ctx["uid"]
    cx, hy, r = ctx["cx"], ctx["horizon"], ctx["r"]
    top = hy - r

    def field(x, y):
        return 0.12 + 0.88 * clamp((y - top) / r) ** 1.3

    path = f"M{f(cx - r)},{f(hy)} A{f(r)},{f(r)} 0 0 1 {f(cx + r)},{f(hy)} Z"
    dots = halftone((cx - r, top, cx + r, hy), field, ctx["pitch"], angle=15)

    def sky(x, y):
        dist = math.hypot(x - cx, y - hy)
        if y > hy - 2 or dist < r + ctx["pitch"]:
            return 0
        return 0.22 * clamp(1 - (dist - r) / ctx["glow"]) ** 1.5

    skydots = halftone((max(0, cx - r - ctx["glow"]), 0, min(W, cx + r + ctx["glow"]), hy), sky, ctx["pitch"], angle=15)
    hx0, hx1 = ctx["hline"]
    return (
        f'<defs><clipPath id="{uid}-sun"><path d="{path}"></path></clipPath></defs>'
        f'<g fill="{acc}">{skydots}</g>'
        f'<g fill="{acc}" clip-path="url(#{uid}-sun)">{dots}</g>'
        + el("rect", x=f(hx0), y=f(hy), width=f(hx1 - hx0), height=f(ctx["hw"]), fill=acc)
    )


MOTIFS = {
    "bars": motif_bars,
    "split": motif_split,
    "eclipse": motif_eclipse,
    "dots": motif_dots,
    "dawn": motif_dawn,
}


def capsule_ctx(gid, g):
    # The launcher overlays title, tag chip and Install button on the bottom ~45% and a
    # COMING SOON badge top-left, so every motif sits in the upper ~55% (y < ~480).
    W, H = 600, 900
    uid = f"{gid}-cap"
    corner = lambda x, y: 0.9 * clamp(1 - math.hypot(x - W, y) / 620) ** 1.2
    m = g["motif"]
    if m == "bars":
        return dict(uid=uid, x0=70, yb=466, w=70, gap=30, h=300, step=36,
                    shadow=(18, 12), pitch=12, bg_field=corner)
    if m == "split":
        return dict(uid=uid, cx=306, cy=262, r=178, slide=24, sep=8, pitch=11,
                    bg_field=lambda x, y: 0.7 * clamp(1 - math.hypot(x - W, y) / 560) ** 1.3)
    if m == "eclipse":
        return dict(uid=uid, cx=300, cy=262, r=118, reach=150, pitch=11, rim=5, bead=8,
                    fade=lambda x, y: smooth(56, 130, y))
    if m == "dots":
        return dict(uid=uid, r=76, centers=[(212, 172), (388, 172), (212, 348), (388, 348)],
                    pitch=12, stroke=5, bg_field=corner)
    if m == "dawn":
        return dict(uid=uid, cx=300, horizon=440, r=196, pitch=12, glow=110, hline=(0, W), hw=4)
    raise KeyError(m)


CAPSULE_FADE = (440, 600)  # ink fade: fully transparent at y=440, solid ink from y=600 down


def hero_ctx(gid, g):
    W, H = 1920, 620
    uid = f"{gid}-hero"
    # visual interest lives right of ~1060px; everything fades out to the left
    right = lambda x, y: 0.85 * smooth(1000, 1920, x) ** 1.4
    m = g["motif"]
    if m == "bars":
        return dict(uid=uid, x0=1110, yb=600, w=100, gap=42, h=520, step=56,
                    shadow=(26, 18), pitch=14, bg_field=right)
    if m == "split":
        return dict(uid=uid, cx=1420, cy=290, r=240, slide=30, sep=10, pitch=12, bg_field=right)
    if m == "eclipse":
        return dict(uid=uid, cx=1430, cy=290, r=170, reach=250, pitch=12, rim=6, bead=10)
    if m == "dots":
        return dict(uid=uid, r=98, centers=[(1310, 180), (1540, 180), (1310, 400), (1540, 400)],
                    pitch=14, stroke=6, bg_field=right)
    if m == "dawn":
        return dict(uid=uid, cx=1420, horizon=430, r=250, pitch=13, glow=150, hline=(1070, W), hw=4)
    raise KeyError(m)


# --------------------------------------------------------------------------
# Shared print furniture: crop marks, registration target, slug line
# --------------------------------------------------------------------------

def print_marks(W, H, inset=18, length=16, color=PAPER, opacity=0.34, corners="tl tr bl br"):
    s = []
    marks = {"tl": (inset, inset, -1, -1), "tr": (W - inset, inset, 1, -1),
             "bl": (inset, H - inset, -1, 1), "br": (W - inset, H - inset, 1, 1)}
    for (x, y, hx, vy) in (marks[k] for k in corners.split()):
        s.append(el("line", x1=f(x), y1=f(y), x2=f(x + hx * length), y2=f(y), stroke=color, stroke_width="1.5"))
        s.append(el("line", x1=f(x), y1=f(y), x2=f(x), y2=f(y + vy * length), stroke=color, stroke_width="1.5"))
    cx, cy = W / 2, inset + 2
    s.append(el("circle", cx=f(cx), cy=f(cy), r="6.5", fill="none", stroke=color, stroke_width="1.5"))
    s.append(el("line", x1=f(cx - 13), y1=f(cy), x2=f(cx + 13), y2=f(cy), stroke=color, stroke_width="1.5"))
    s.append(el("line", x1=f(cx), y1=f(cy - 13), x2=f(cx), y2=f(cy + 13), stroke=color, stroke_width="1.5"))
    return f'<g opacity="{opacity}">{"".join(s)}</g>'


# --------------------------------------------------------------------------
# Typography (HTML, inline styles only so the same markup works on the canvas)
# --------------------------------------------------------------------------
ARCHIVO = "font-family: 'Archivo', sans-serif"
MONO = "font-family: 'IBM Plex Mono', monospace"


def rich(text, accent):
    return text.replace("<b>", f'<span style="color: {accent}">').replace("</b>", "</span>")


def logo_text(g, color=PAPER):
    acc = g["accent"]
    kick = ""
    if g["kicker"]:
        kick = (f'<div style="{ARCHIVO}; font-stretch: 125%; font-weight: 800; font-size: 50px; '
                f'letter-spacing: 0.2em; color: {color}; line-height: 1; margin-bottom: 18px">{g["kicker"]}</div>')
    size = g.get("logo_size", 164)
    main = (f'<div style="{ARCHIVO}; font-stretch: 62%; font-weight: 900; font-size: {size}px; line-height: 0.84; '
            f'letter-spacing: -0.005em; color: {color}; white-space: nowrap">{rich(g["logo_line"], acc)}</div>')
    sub = ""
    if g["sub"]:
        sub = (f'<div style="{ARCHIVO}; font-stretch: 125%; font-weight: 800; font-size: 46px; letter-spacing: 0.16em; '
               f'color: {color}; line-height: 1; margin-top: 22px">{g["sub"]}</div>')
    return (
        '<div style="position: absolute; left: 0; top: 0; width: 1280px; height: 345px; display: flex; '
        f'flex-direction: column; justify-content: center; align-items: flex-start">{kick}{main}{sub}</div>'
    )


# --------------------------------------------------------------------------
# Brand mark & icons (16-unit grid)
# --------------------------------------------------------------------------

def badge_path(detail):
    if detail == "small":
        return "M5,0 H16 V16 H0 V5 Z"
    r = 1.6
    return (f"M5,0 H{16 - r} Q16,0 16,{r} V{16 - r} Q16,16 {16 - r},16 H{r} Q0,16 0,{16 - r} V5 Z")


def ul_glyph(detail):
    # U (left stem, counter, right stem) whose right stem is also the L; the foot
    # ends in a cut parallel to the badge's corner cut.
    if detail == "small":
        return "M3,3 H6 V10 H8 V3 H11 V10 H14 V13 H3 Z"
    return ("M3,3.2 H6 V10 H8 V3.2 H11 V10 H14.6 L12.4,13 H5.3 Q3,13 3,10.7 Z")


def game_glyph(motif, detail):
    small = detail == "small"
    if motif == "bars":
        # four equal bars in a small echelon
        lean = 0.3 if small else 0.36
        w, gap, h, step = (2, 1, 7.4, 0.9) if small else (2.05, 1.0, 7.6, 0.9)
        bars = [f'<polygon points="{pts(para(1.9 + i * (w + gap), 13.4 - i * step, w, h, lean))}"/>'
                for i in range(4)]
        return "".join(bars)
    if motif == "split":
        d = (math.sqrt(0.5), -math.sqrt(0.5))
        n = (d[1], -d[0])
        cx, cy, r, s, e = 8.4, 8.6, 5.2, 1.1, 0.55
        up = half_disc_path(cx + s * d[0] + e * n[0], cy + s * d[1] + e * n[1], r, d[0], d[1], True)
        lo = half_disc_path(cx - s * d[0] - e * n[0], cy - s * d[1] - e * n[1], r, d[0], d[1], False)
        return f'<path d="{up}"/><path d="{lo}"/>'
    if motif == "eclipse":
        return ('<circle cx="8.5" cy="8.5" r="5.9" fill="none" stroke="currentColor" stroke-width="1.3"/>'
                '<circle cx="8.5" cy="8.5" r="3.7"/>'
                + ('' if small else f'<circle cx="{f(8.5 + 5.9 * math.cos(math.radians(-50)))}" '
                   f'cy="{f(8.5 + 5.9 * math.sin(math.radians(-50)))}" r="1.35" fill="{PAPER}"/>'))
    if motif == "dots":
        r = 2.35
        return "".join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y in ((6, 6), (11, 6), (6, 11), (11, 11)))
    if motif == "dawn":
        return ('<path d="M3.4,10.4 A4.6,4.6 0 0 1 12.6,10.4 Z"/>'
                '<rect x="1.5" y="11.7" width="13" height="1.5"/>')
    raise KeyError(motif)


def icon_svg(fill, glyph, detail, size_px, halftone_detail=False, pad=True):
    vb = "-1 -1 18 18" if (pad and detail == "large") else "0 0 16 16"
    extra = ""
    if halftone_detail and detail == "large":
        # a whisper of Ben-Day dots along the bottom-right edge
        dots = halftone((0, 0, 16, 16), lambda x, y: 0.55 * smooth(15, 32, x + y) ** 1.2, 0.72, angle=45, rmin=0.03)
        extra = (f'<clipPath id="bclip"><path d="{badge_path(detail)}"/></clipPath>'
                 f'<g fill="{INK}" opacity="0.12" clip-path="url(#bclip)">{dots}</g>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{size_px}" height="{size_px}" '
        f'style="display: block; color: {INK}">'
        f'<path d="{badge_path(detail)}" fill="{fill}"/>{extra}<g fill="{INK}">{glyph}</g></svg>'
    )


def brand_svg(detail, size_px, pad=True):
    return icon_svg(PRIMARY, f'<path d="{ul_glyph(detail)}"/>', detail, size_px, halftone_detail=True, pad=pad)


def game_icon_svg(g, detail, size_px):
    return icon_svg(g["accent"], game_glyph(g["motif"], detail), detail, size_px)


# --------------------------------------------------------------------------
# Page assembly
# --------------------------------------------------------------------------

def page(W, H, inner, bg=INK, title="Ultimate Legends art"):
    bgcss = "transparent" if bg is None else bg
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<style>html,body{{margin:0;padding:0;background:transparent;overflow:hidden}}</style>
</head>
<body>
{art_root(W, H, inner, bgcss)}
</body>
</html>
"""


def art_root(W, H, inner, bgcss):
    return (f'<div style="position: relative; width: {W}px; height: {H}px; overflow: hidden; background: {bgcss}">'
            f"{inner}</div>")


def svg_layer(W, H, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
            f'style="position: absolute; left: 0; top: 0; display: block">{body}</svg>')


def capsule_inner(gid):
    g = GAMES[gid]
    W, H = 600, 900
    art = MOTIFS[g["motif"]](g, W, H, capsule_ctx(gid, g))
    # No baked-in text below the motif: the launcher draws title, chip and button there.
    f0, f1 = CAPSULE_FADE
    fade = (f'<defs><linearGradient id="{gid}-cap-fade" x1="0" y1="{f0}" x2="0" y2="{f1}" '
            f'gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="{INK}" stop-opacity="0"></stop>'
            f'<stop offset="1" stop-color="{INK}" stop-opacity="1"></stop></linearGradient></defs>'
            + el("rect", x="0", y=f(f0), width=f(W), height=f(H - f0), fill=f"url(#{gid}-cap-fade)"))
    # top-left corner stays empty for the launcher's COMING SOON badge
    marks = print_marks(W, H, corners="tr")
    code = (f'<div style="position: absolute; right: 46px; top: 40px; {MONO}; font-weight: 500; font-size: 12px; '
            f'letter-spacing: 0.22em; color: {PAPER}; opacity: 0.5; line-height: 1; white-space: nowrap">'
            f'ULTIMATE LEGENDS / {gid.upper()}</div>')
    return svg_layer(W, H, art + fade + marks) + code


def hero_inner(gid):
    g = GAMES[gid]
    W, H = 1920, 620
    return svg_layer(W, H, MOTIFS[g["motif"]](g, W, H, hero_ctx(gid, g)))


def logo_inner(gid):
    return logo_text(GAMES[gid])


def brand_board_inner():
    """1280x720 overview board: mark, wordmark, palette, game accents."""
    sw = []
    for name, hexv in (("Ink", INK), ("Surface", INK_2), ("Paper", PAPER), ("Legend Yellow", PRIMARY), ("Process Cyan", SECONDARY)):
        border = f"border: 1px solid {PAPER}33; " if hexv in (INK, INK_2) else ""
        sw.append(
            f'<div style="display: flex; flex-direction: column; gap: 10px; width: 132px">'
            f'<div style="{border}box-sizing: border-box; height: 72px; background: {hexv}"></div>'
            f'<div style="{ARCHIVO}; font-weight: 700; font-size: 15px; color: {PAPER}">{name}</div>'
            f'<div style="{MONO}; font-size: 13px; color: {PAPER}; opacity: 0.6">{hexv}</div></div>'
        )
    gs = []
    for gid in ORDER:
        g = GAMES[gid]
        gs.append(
            f'<div style="display: flex; flex-direction: column; gap: 10px; width: 132px">'
            f'<div style="display: flex; gap: 10px; align-items: center">{game_icon_svg(g, "large", 44)}'
            f'<div style="{MONO}; font-weight: 600; font-size: 13px; color: {PAPER}; letter-spacing: 0.1em">{gid.upper()}</div></div>'
            f'<div style="height: 10px; background: {g["accent"]}"></div>'
            f'<div style="{ARCHIVO}; font-weight: 700; font-size: 15px; color: {PAPER}">{g["accent_name"]}</div>'
            f'<div style="{MONO}; font-size: 13px; color: {PAPER}; opacity: 0.6">{g["accent"]}</div></div>'
        )
    return (
        svg_layer(1280, 720, print_marks(1280, 720, inset=22))
        + '<div style="position: absolute; left: 80px; top: 88px; display: flex; gap: 48px; align-items: center">'
        + brand_svg("large", 220)
        + '<div style="display: flex; flex-direction: column; gap: 16px">'
        + f'<div style="{MONO}; font-weight: 500; font-size: 13px; letter-spacing: 0.22em; color: {PAPER}; opacity: 0.55">BRAND SHEET / 01</div>'
        + f'<div style="{ARCHIVO}; font-stretch: 62%; font-weight: 900; font-size: 128px; line-height: 0.86; color: {PAPER}">ULTIMATE<br>LEGENDS</div>'
        + '<div style="display: flex; gap: 14px; align-items: flex-end">'
        + brand_svg("small", 16, pad=False) + brand_svg("small", 24, pad=False) + brand_svg("small", 32, pad=False)
        + brand_svg("large", 48)
        + '</div></div></div>'
        + f'<div style="position: absolute; left: 80px; top: 420px; display: flex; flex-direction: column; gap: 36px">'
        + f'<div style="display: flex; gap: 24px">{"".join(sw)}</div>'
        + f'<div style="display: flex; gap: 24px">{"".join(gs)}</div></div>'
    )


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------

def jobs():
    """(name, W, H, inner_html, background or None for transparent)"""
    out = []
    for gid in ORDER:
        out.append((f"{gid}/capsule", 600, 900, capsule_inner(gid), INK))
        out.append((f"{gid}/hero", 1920, 620, hero_inner(gid), INK))
        out.append((f"{gid}/logo", 1280, 345, logo_inner(gid), None))
        # icon sources: large (with padding) and small (pixel-grid) variants
        out.append((f"{gid}/icon-large", 512, 512, game_icon_svg(GAMES[gid], "large", 512), None))
        out.append((f"{gid}/icon-small", 512, 512, game_icon_svg(GAMES[gid], "small", 512), None))
        out.append((f"{gid}/icon-small-480", 480, 480, game_icon_svg(GAMES[gid], "small", 480), None))
    out.append(("brand/ul-mark", 300, 300, brand_svg("large", 300), None))
    out.append(("brand/app-icon-large", 512, 512, brand_svg("large", 512), None))
    out.append(("brand/app-icon-large-480", 480, 480, brand_svg("large", 480), None))
    out.append(("brand/app-icon-small", 512, 512, brand_svg("small", 512, pad=False), None))
    out.append(("brand/app-icon-small-480", 480, 480, brand_svg("small", 480, pad=False), None))
    out.append(("brand/brand-sheet", 1280, 720, brand_board_inner(), INK))
    return out


def write_html():
    HTML_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for name, W, H, inner, bg in jobs():
        p = HTML_DIR / f"{name}.html"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(page(W, H, inner, bg, title=name), encoding="utf-8")
        written.append((name, W, H, bg, p))
    return written


def edge_shot(html, png, W, H, transparent, profile):
    args = [EDGE, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--window-size={W},{H}", "--virtual-time-budget=10000", "--disable-gpu",
            "--no-first-run", "--no-default-browser-check", f"--user-data-dir={profile}",
            f"--screenshot={png}"]
    if transparent:
        args.append("--default-background-color=00000000")
    args.append(html.as_uri())
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def render(written):
    from PIL import Image

    tmp = Path(tempfile.mkdtemp(prefix="ul-art-"))
    profile = tmp / "profile"
    shots = {}
    for name, W, H, bg, p in written:
        png = tmp / (name.replace("/", "__") + ".png")
        edge_shot(p, png, W, H, bg is None, profile)
        im = Image.open(png).convert("RGBA")
        if im.size != (W, H):
            im = im.crop((0, 0, W, H))
        shots[name] = im
        print(f"rendered {name} {im.size}")

    def ico_frames(prefix, sizes):
        # <=32 px uses the pixel-grid "small" drawing, larger sizes the refined one.
        # Pick a supersampled render whose size is an exact multiple, then box-filter down.
        frames = []
        for s in sizes:
            variant = "small" if s <= 32 else "large"
            src, flt = shots[f"{prefix}-{variant}"], Image.Resampling.LANCZOS
            for key in (f"{prefix}-{variant}", f"{prefix}-{variant}-480"):
                if key in shots and shots[key].size[0] % s == 0:
                    src, flt = shots[key], Image.Resampling.BOX
                    break
            frames.append(src.resize((s, s), flt))
        return frames

    def save_ico(path, frames):
        path.parent.mkdir(parents=True, exist_ok=True)
        big = frames[-1]
        big.save(path, format="ICO", sizes=[fr.size for fr in frames], append_images=frames[:-1])

    def has(*names):
        return all(n in shots for n in names)

    for gid in ORDER:
        d = GAMES_OUT / gid
        d.mkdir(parents=True, exist_ok=True)
        if has(f"{gid}/capsule"):
            shots[f"{gid}/capsule"].convert("RGB").save(d / "capsule.jpg", quality=88, optimize=True, progressive=True)
        if has(f"{gid}/hero"):
            shots[f"{gid}/hero"].convert("RGB").save(d / "hero.jpg", quality=88, optimize=True, progressive=True)
        if has(f"{gid}/logo"):
            shots[f"{gid}/logo"].save(d / "logo.png", optimize=True)
        if has(f"{gid}/icon-large", f"{gid}/icon-small", f"{gid}/icon-small-480"):
            save_ico(d / "icon.ico", ico_frames(f"{gid}/icon", [16, 32, 48, 256]))

    if has("brand/ul-mark"):
        BRAND_OUT.mkdir(parents=True, exist_ok=True)
        shots["brand/ul-mark"].save(BRAND_OUT / "ul-mark.png", optimize=True)
    if has("brand/app-icon-large", "brand/app-icon-large-480", "brand/app-icon-small", "brand/app-icon-small-480"):
        app = ico_frames("brand/app-icon", [16, 24, 32, 48, 64, 128, 256])
        save_ico(APP_RES / "icon.ico", app)
        app[-1].save(APP_RES / "icon.png", optimize=True)
    if has("brand/brand-sheet"):
        preview = HERE / "preview"
        preview.mkdir(exist_ok=True)
        shots["brand/brand-sheet"].convert("RGB").save(preview / "brand-sheet.jpg", quality=88)
    shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# Claude Design canvas artboards
# --------------------------------------------------------------------------

def dc_file(title, W, H, inner, bg):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="{FONTS.replace('&', '&amp;')}">
<style>
body{{margin:0;font-family:'Archivo',sans-serif;background:{INK}}}
</style>
</helmet>
{art_root(W, H, inner, bg)}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{W},"height":{H}}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
"""


def write_canvas(root):
    global CANVAS_MODE
    CANVAS_MODE = True
    proj = Path(root) / "project"
    proj.mkdir(parents=True, exist_ok=True)
    boards, order = {}, []

    def add(fname, title, W, H, inner, bg, x, y):
        # icon/badge markup uses self-closing tags; expand them for the canvas parser
        html = re.sub(r"<(path|circle|polygon|rect|line)([^<>]*?)/>", r"<\1\2></\1>",
                      dc_file(title, W, H, inner, bg))
        (proj / fname).write_text(html, encoding="utf-8")
        boards[fname] = {"x": x, "y": y, "w": W, "h": H, "title": title}
        order.append(fname)

    add("Main.dc.html", "Brand sheet", 1280, 720, brand_board_inner(), INK, 0, 0)
    add("UL-Mark.dc.html", "ul-mark.png 300x300", 300, 300, brand_svg("large", 300), "transparent", 1360, 0)
    add("App-Icon.dc.html", "App icon 256x256", 256, 256, brand_svg("large", 256), "transparent", 1740, 0)
    y = 720 + 360
    for i, gid in enumerate(ORDER):
        add(f"{gid}-capsule.dc.html", f"{gid} / capsule 600x900", 600, 900, capsule_inner(gid), INK, i * 680, y)
    y += 900 + 360
    for i, gid in enumerate(ORDER):
        add(f"{gid}-hero.dc.html", f"{gid} / hero 1920x620", 1920, 620, hero_inner(gid), INK, 0, y + i * (620 + 120))
    xl = 1920 + 200
    for i, gid in enumerate(ORDER):
        add(f"{gid}-logo.dc.html", f"{gid} / logo 1280x345", 1280, 345, logo_inner(gid), INK, xl, y + i * (620 + 120))
    xi = xl + 1280 + 120
    for i, gid in enumerate(ORDER):
        add(f"{gid}-icon.dc.html", f"{gid} / icon 256", 256, 256, game_icon_svg(GAMES[gid], "large", 256),
            "transparent", xi, y + i * (620 + 120))
    notes = {
        "brand": {"x": 0, "y": -300, "text": "Ultimate Legends - brand", "kind": "title1", "maxW": 2000},
        "caps": {"x": 0, "y": 720 + 360 - 300, "text": "Library capsules", "kind": "title1", "maxW": 3320},
        "heroes": {"x": 0, "y": 720 + 360 + 900 + 360 - 300, "text": "Heroes, logos and game icons",
                   "kind": "title1", "maxW": 3800},
    }
    from datetime import datetime, timezone
    index = {
        "v": 3,
        "createdOnFiles": {"v": 1, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "title": "Ultimate Legends Art",
        "launch": {"view": "canvas"},
        "pages": [],
        "boards": boards,
        "order": order,
        "notes": notes,
        "designSystems": [],
    }
    (proj / "canvas.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    CANVAS_MODE = False
    print(f"canvas files written to {proj}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true", help="render deliverables into the repo")
    ap.add_argument("--canvas", metavar="DIR", help="write Claude Design canvas artboards to DIR")
    ap.add_argument("--only", metavar="KIND", nargs="+",
                    help="with --render: only render jobs whose name contains one of these words "
                         "(e.g. --only capsule, --only hero logo, --only mua2/)")
    a = ap.parse_args()
    written = write_html()
    print(f"wrote {len(written)} HTML sources to {HTML_DIR}")
    if a.render:
        if a.only:
            written = [w for w in written if any(k in w[0] for k in a.only)]
        render(written)
    if a.canvas:
        write_canvas(a.canvas)


if __name__ == "__main__":
    sys.exit(main())
