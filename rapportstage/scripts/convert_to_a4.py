"""Convert Letter cover/end PDFs to full-bleed A4 (edge-to-edge).

1. Rasterise the Letter backup at high DPI
2. Crop near-white side margins from the artwork
3. Stretch the content exactly to A4 pixels
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
A4_W_PT = 595.276
A4_H_PT = 841.890
DPI = 300
A4_W_PX = int(round(A4_W_PT * DPI / 72))
A4_H_PX = int(round(A4_H_PT * DPI / 72))


def content_bbox(image: Image.Image, thresh: int = 250) -> tuple[int, int, int, int]:
    gray = image.convert("L")
    width, height = gray.size
    pixels = gray.load()
    min_x, min_y, max_x, max_y = width, height, 0, 0
    for y in range(height):
        for x in range(width):
            if pixels[x, y] < thresh:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    pad = 2
    return (
        max(0, min_x - pad),
        max(0, min_y - pad),
        min(width, max_x + 1 + pad),
        min(height, max_y + 1 + pad),
    )


def convert_file(src: Path) -> None:
    bak = src.with_name(f"{src.stem}_letter_backup.pdf")
    if not bak.exists():
        raise SystemExit(f"Missing Letter backup: {bak.name}")

    prefix = ROOT / "build" / f"_raster_{src.stem}"
    prefix.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pdftoppm", "-png", "-r", str(DPI), "-singlefile", str(bak), str(prefix)],
        check=True,
    )
    png = Path(f"{prefix}.png")
    image = Image.open(png).convert("RGB")
    box = content_bbox(image)
    cropped = image.crop(box)
    filled = cropped.resize((A4_W_PX, A4_H_PX), Image.Resampling.LANCZOS)

    tmp = src.with_name(f"{src.stem}_a4_tmp.pdf")
    filled.save(tmp, "PDF", resolution=float(DPI))
    tmp.replace(src)

    page = PdfReader(str(src)).pages[0]
    w = float(page.mediabox.width)
    h = float(page.mediabox.height)
    print(
        f"{src.name}: crop {box} from {image.size} -> {filled.size} px; "
        f"pdf {w:.2f}x{h:.2f}"
    )
    if abs(w - A4_W_PT) > 2 or abs(h - A4_H_PT) > 2:
        raise SystemExit(f"{src.name} is not A4 after conversion")


def main() -> int:
    for name in ("cover.pdf", "end.pdf"):
        convert_file(ROOT / name)
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
