#!/usr/bin/env python3
"""Generate the extension's PNG icons (no third-party deps).

Renders at 4x and box-downsamples for cheap antialiasing.
Run:  python3 tools/make-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (16, 32, 48, 128, 512)
SS = 4  # supersampling factor

BG = (37, 99, 235)        # blue
BG_DARK = (30, 64, 175)   # darker blue for the zipper band
CARD = (255, 255, 255)
HOUSE = (37, 99, 235)
ZIP = (250, 204, 21)      # yellow zipper tab


def rounded_rect(px, size, x0, y0, x1, y1, r, color):
    for y in range(max(0, int(y0)), min(size, int(y1))):
        for x in range(max(0, int(x0)), min(size, int(x1))):
            # corner rounding
            cx = min(max(x, x0 + r), x1 - r - 1)
            cy = min(max(y, y0 + r), y1 - r - 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y * size + x] = color


def triangle(px, size, p0, p1, p2, color):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])

    xs = [p[0] for p in (p0, p1, p2)]
    ys = [p[1] for p in (p0, p1, p2)]
    for y in range(max(0, int(min(ys))), min(size, int(max(ys)) + 1)):
        for x in range(max(0, int(min(xs))), min(size, int(max(xs)) + 1)):
            d1 = sign((x, y), p0, p1)
            d2 = sign((x, y), p1, p2)
            d3 = sign((x, y), p2, p0)
            neg = d1 < 0 or d2 < 0 or d3 < 0
            pos = d1 > 0 or d2 > 0 or d3 > 0
            if not (neg and pos):
                px[y * size + x] = color


def render(size):
    px = [(0, 0, 0, 0)] * (size * size)
    s = size
    rounded_rect(px, s, 0, 0, s, s, s * 0.22, BG + (255,))
    # white "photo card" with a house on it
    m = s * 0.14
    rounded_rect(px, s, m, s * 0.20, s - m, s - s * 0.20, s * 0.06, CARD + (255,))
    # house roof + body
    cx = s * 0.5
    triangle(px, s, (cx, s * 0.30), (s * 0.30, s * 0.50), (s * 0.70, s * 0.50), HOUSE + (255,))
    rounded_rect(px, s, s * 0.34, s * 0.48, s * 0.66, s * 0.70, s * 0.02, HOUSE + (255,))
    # zipper band across the bottom
    rounded_rect(px, s, s * 0.10, s * 0.74, s * 0.90, s * 0.90, s * 0.04, BG_DARK + (255,))
    teeth = 6
    for i in range(teeth):
        t = (i + 0.5) / teeth
        x = s * 0.10 + t * s * 0.80
        rounded_rect(px, s, x - s * 0.015, s * 0.775, x + s * 0.015, s * 0.815, s * 0.012, ZIP + (255,))
    rounded_rect(px, s, s * 0.455, s * 0.815, s * 0.545, s * 0.885, s * 0.03, ZIP + (255,))
    return px


def downsample(px, size, target):
    factor = size // target
    out = bytearray()
    for y in range(target):
        out.append(0)  # filter type 0
        for x in range(target):
            r = g = b = a = 0
            for dy in range(factor):
                for dx in range(factor):
                    p = px[(y * factor + dy) * size + (x * factor + dx)]
                    r += p[0] * p[3]
                    g += p[1] * p[3]
                    b += p[2] * p[3]
                    a += p[3]
            n = factor * factor
            if a:
                out += bytes((r // a, g // a, b // a, a // n))
            else:
                out += b"\x00\x00\x00\x00"
    return bytes(out)


def write_png(path, size, raw):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    big = render(512)
    for target in SIZES:
        raw = downsample(big, 512, target) if target < 512 else downsample(big, 512, 512)
        name = "icon512.png" if target == 512 else "icon%d.png" % target
        write_png(os.path.join(OUT_DIR, name), target, raw)
        print("wrote", os.path.join(OUT_DIR, name))


if __name__ == "__main__":
    main()
