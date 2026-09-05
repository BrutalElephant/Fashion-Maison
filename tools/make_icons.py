#!/usr/bin/env python3
"""Generate Fashion Maison PWA icons (pure stdlib PNG writer, no dependencies).

Draws the house monogram in the existing brand palette (#171513 ink, #dfb63f
gold) so install icons match the storefront without new artwork or fonts.
Outputs: assets/icons/icon-192.png, icon-512.png, maskable-512.png
"""
import os
import struct
import zlib

INK = (0x17, 0x15, 0x13)
GOLD = (0xDF, 0xB6, 0x3F)
CREAM = (0xF0, 0xD4, 0x76)


def make_px(size, maskable=False):
    px = [[INK for _ in range(size)] for _ in range(size)]

    def setp(x, y, c):
        if 0 <= x < size and 0 <= y < size:
            px[y][x] = c

    def rect(x0, y0, w, h, c):
        for y in range(int(y0), int(y0 + h)):
            for x in range(int(x0), int(x0 + w)):
                setp(x, y, c)

    def line(x0, y0, x1, y1, w, c):
        dx, dy = x1 - x0, y1 - y0
        steps = int(max(abs(dx), abs(dy)) * 2) or 1
        for i in range(steps + 1):
            t = i / steps
            cx, cy = x0 + dx * t, y0 + dy * t
            r = w / 2.0
            for yy in range(int(cy - r), int(cy + r) + 1):
                for xx in range(int(cx - r), int(cx + r) + 1):
                    if (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r:
                        setp(xx, yy, c)

    pad = int(size * (0.18 if maskable else 0.075))
    inner = size - 2 * pad
    # double rule frame
    rect(pad, pad, inner, max(2, size // 128), GOLD)
    rect(pad, size - pad - max(2, size // 128), inner, max(2, size // 128), GOLD)
    rect(pad, pad, max(2, size // 128), inner, GOLD)
    rect(size - pad - max(2, size // 128), pad, max(2, size // 128), inner, GOLD)

    # Monogram "FM" built from strokes, centred.
    top = size * 0.34
    bot = size * 0.66
    mid = (top + bot) / 2
    lw = max(3, int(size * 0.045))
    # F
    fx = size * 0.27
    line(fx, top, fx, bot, lw, CREAM)
    line(fx, top, fx + size * 0.14, top, lw, CREAM)
    line(fx, mid, fx + size * 0.10, mid, lw, CREAM)
    # M
    m0 = size * 0.50
    m1 = size * 0.585
    m2 = size * 0.67
    m3 = size * 0.755
    line(m0, bot, m0, top, lw, CREAM)
    line(m0, top, m1, mid + size * 0.06, lw, CREAM)
    line(m2, mid + size * 0.06, m3, top, lw, CREAM)
    line(m3, top, m3, bot, lw, CREAM)

    return px


def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = b"".join(b"\x00" + b"".join(struct.pack("BBB", *c) for c in row) for row in px)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({w}x{h})")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "assets", "icons")
    write_png(os.path.join(out, "icon-192.png"), make_px(192))
    write_png(os.path.join(out, "icon-512.png"), make_px(512))
    write_png(os.path.join(out, "maskable-512.png"), make_px(512, maskable=True))
