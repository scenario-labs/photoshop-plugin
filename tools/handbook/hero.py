# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow==11.3.0"]
# ///
"""Builds docs/media/hero.jpg, the README and handbook banner, from real
pixels only: the painted frame before the edit, the same frame with the
Replace inside take landed, and the Scenario panel cut from a Photoshop
window capture.

    uv run tools/handbook/hero.py \\
      --before <frame before the edit>.png \\
      --take <the take, box sized>.png --mask <capture mask>.png \\
      --box 620,0,916,590 \\
      --panel <Photoshop window capture>.jpg --panel-crop 1226,26,371,459 \\
      --out docs/media/hero.jpg

The take and its mask come from the plugin data folder (Scenario/edit/ and
captures/<id>/mask.png); --box is the capture box from the job record. The
take lands the way Inside selection lands it: inside the mask, 2 px feather.

Layout, 2400 x 1200: the frame fills the height on the left; a wipe line
through the kite shows the empty sky on the left (before) and the kite on
the right (after); the panel floats on the right over a blurred, darkened
continuation of the same frame, vertically centered, with the same outer
margin as the labels.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 2400, 1200
MARGIN = 64  # outer margin: labels from the top, panel from the right edge
PANEL_W = 624  # 26% of the width


def box(value):
    parts = [int(v) for v in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("x,y,w,h")
    return parts


def font(size):
    for path in (
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


def label(canvas, text, anchor_x, y, align):
    f = font(24)
    draw = ImageDraw.Draw(canvas)
    track = 5  # letter spacing for the mono label
    widths = [draw.textlength(c, font=f) for c in text]
    l, t, r, b = draw.textbbox((0, 0), text, font=f)
    tw = round(sum(widths) + track * (len(text) - 1))
    pad_x, pad_y = 18, 12
    w, h = tw + 2 * pad_x, b - t + 2 * pad_y
    x = anchor_x - w if align == "right" else anchor_x
    pill = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(16, 16, 16, 150))
    canvas.alpha_composite(pill, (x, y))
    cx = x + pad_x
    for c, cw in zip(text, widths):
        draw.text((cx, y + pad_y - t), c, font=f, fill=(255, 255, 255, 235))
        cx += cw + track


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--before", required=True)
    ap.add_argument("--take", required=True)
    ap.add_argument("--mask", required=True)
    ap.add_argument("--box", type=box, required=True, help="capture box in the document, x,y,w,h")
    ap.add_argument("--panel", required=True)
    ap.add_argument("--panel-crop", type=box, required=True, help="the panel in the capture, x,y,w,h")
    ap.add_argument("--wipe", type=float, default=0.55, help="wipe line, share of the width")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    before = Image.open(a.before).convert("RGB")
    bx, by, bw, bh = a.box
    take = Image.open(a.take).convert("RGB").resize((bw, bh), Image.LANCZOS)
    mask = Image.open(a.mask).convert("L").resize((bw, bh), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1))
    after = before.copy()
    after.paste(take, (bx, by), mask)

    # The frame at full height on the left.
    s = H / before.height
    fw = round(before.width * s)
    b_big = before.resize((fw, H), Image.LANCZOS)
    a_big = after.resize((fw, H), Image.LANCZOS)

    # The stage behind the panel: the same frame, cover-scaled, blurred, darkened.
    cover = max(W / before.width, H / before.height)
    stage = after.resize((round(before.width * cover), round(before.height * cover)), Image.LANCZOS)
    stage = stage.crop((stage.width - W, (stage.height - H) // 2, stage.width, (stage.height - H) // 2 + H))
    stage = stage.filter(ImageFilter.GaussianBlur(70))
    stage = Image.blend(stage, Image.new("RGB", (W, H), (22, 22, 24)), 0.8)
    canvas = stage.convert("RGBA")

    # Before left of the wipe, after right of it; the frame fades into the stage.
    wipe = round(W * a.wipe)
    frame = a_big.copy()
    frame.paste(b_big.crop((0, 0, wipe, H)), (0, 0))
    fade = Image.new("L", (fw, H), 255)
    fd = ImageDraw.Draw(fade)
    span = 140
    for x in range(fw - span, fw):
        t = (fw - x) / span
        fd.line([(x, 0), (x, H)], fill=round(255 * t * t * (3 - 2 * t)))
    canvas.paste(frame, (0, 0), fade)

    # Wipe line and handle.
    d = ImageDraw.Draw(canvas)
    d.rectangle((wipe - 1, 0, wipe + 1, H), fill=(255, 255, 255, 235))
    r = 26
    cy = H // 2
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse((wipe - r, cy - r + 4, wipe + r, cy + r + 4), fill=(0, 0, 0, 120))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
    d = ImageDraw.Draw(canvas)
    d.ellipse((wipe - r, cy - r, wipe + r, cy + r), fill=(255, 255, 255, 255))
    for sign in (-1, 1):
        tip = wipe + sign * 15
        d.polygon([(tip, cy), (tip - sign * 8, cy - 8), (tip - sign * 8, cy + 8)], fill=(40, 40, 40, 255))

    label(canvas, "BEFORE", wipe - 22, MARGIN, "right")
    label(canvas, "AFTER", wipe + 22, MARGIN, "left")

    # The panel, cut from the window capture, rounded, with a soft shadow.
    px, py, pw, ph = a.panel_crop
    panel = Image.open(a.panel).convert("RGB").crop((px, py, px + pw, py + ph))
    scale = PANEL_W / pw
    panel = panel.resize((PANEL_W, round(ph * scale)), Image.LANCZOS)
    panel_h = panel.height
    x0 = W - MARGIN - PANEL_W
    y0 = (H - panel_h) // 2
    radius = 22
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + 18, x0 + PANEL_W, y0 + panel_h + 18), radius=radius, fill=(0, 0, 0, 150))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(28)))
    canvas.paste(panel, (x0, y0), rounded_mask(panel.size, radius))
    ImageDraw.Draw(canvas).rounded_rectangle((x0, y0, x0 + PANEL_W - 1, y0 + panel_h - 1), radius=radius, outline=(255, 255, 255, 40), width=2)

    out = canvas.convert("RGB")
    for q in (88, 84, 80, 76, 72):
        out.save(a.out, "JPEG", quality=q, optimize=True, progressive=True, subsampling="4:2:0")
        if Path(a.out).stat().st_size < 500_000:
            break
    print(f"{a.out}: {W}x{H}, quality {q}, {Path(a.out).stat().st_size // 1024} KB; panel at x {x0}, y {y0} to {y0 + panel_h} (margins {y0} and {H - y0 - panel_h}); wipe at x {wipe}")


if __name__ == "__main__":
    main()
