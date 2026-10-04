#!/usr/bin/env python3
"""Erzeugt das JellyLibrary-App-Icon (stilisierte Qualle im Farbverlauf) als
1024er-Master resources/icon.png. Die Android-Varianten erzeugt danach
`npx capacitor-assets generate --android`."""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
S = 1024

# --- Hintergrund: diagonaler Farbverlauf Lila -> Blau ---
bg = Image.new("RGB", (S, S))
top = (108, 62, 244)      # #6C3EF4
bot = (45, 156, 219)      # #2D9CDB
px = bg.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        px[x, y] = (r, g, b)

img = bg.convert("RGBA")
draw = ImageDraw.Draw(img)

white = (255, 255, 255, 255)
soft = (255, 255, 255, 235)

# --- Quallen-Schirm (Halbkuppel) ---
cx = S // 2
dome_top = int(S * 0.24)
dome_w = int(S * 0.52)
dome_h = int(S * 0.42)
left = cx - dome_w // 2
right = cx + dome_w // 2
dome_bottom = dome_top + dome_h
# obere Halbellipse
draw.pieslice([left, dome_top, right, dome_top + dome_h * 2], 180, 360, fill=soft)
# gewellter unterer Rand (Scallop-Optik) via kleine weisse Kreise
scallops = 4
sw = dome_w / scallops
by = dome_bottom
for i in range(scallops):
    x0 = left + i * sw + sw / 2
    draw.ellipse([x0 - sw * 0.5, by - sw * 0.5, x0 + sw * 0.5, by + sw * 0.45], fill=soft)

# --- Tentakel (wellenfoermige Baender) ---
n_tent = 5
tent_top = int(by - sw * 0.1)
tent_len = int(S * 0.30)
for i in range(n_tent):
    bx = left + dome_w * (0.14 + 0.72 * i / (n_tent - 1))
    amp = S * 0.020
    width = max(10, int(S * 0.028))
    pts = []
    steps = 40
    for s in range(steps + 1):
        t = s / steps
        y = tent_top + tent_len * t
        x = bx + math.sin(t * math.pi * 2.4 + i) * amp * (0.4 + t)
        pts.append((x, y))
    draw.line(pts, fill=soft, width=width, joint="curve")
    # abgerundetes Ende
    ex, ey = pts[-1]
    draw.ellipse([ex - width/2, ey - width/2, ex + width/2, ey + width/2], fill=soft)

# --- kleine "Augen"/Leuchtpunkte im Schirm fuer Charakter ---
eye_y = dome_top + int(dome_h * 0.62)
for dx in (-int(dome_w*0.12), int(dome_w*0.12)):
    draw.ellipse([cx + dx - 26, eye_y - 26, cx + dx + 26, eye_y + 26],
                 fill=(108, 62, 244, 255))

# --- Runde Ecken (Maske) ---
radius = int(S * 0.18)
mask = Image.new("L", (S, S), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle([0, 0, S, S], radius=radius, fill=255)
img.putalpha(mask)

master = img
master.save(os.path.join(OUT, "icon.png"))

print("Icon geschrieben:", os.path.join(OUT, "icon.png"))
