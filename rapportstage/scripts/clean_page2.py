"""Clean and denoise the ESPRIT page-2 scan for sharper PDF inclusion."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "hamouda PG 2_page-0001 (1).pdf"
OUTPUT_PDF = ROOT / "page2.pdf"
OUTPUT_SOURCE_CLEAN = ROOT / "hamouda PG 2_page-0001 (1)_clean.pdf"
OUTPUT_PNG = ROOT / "page2_clean_preview.png"
TMP_PREFIX = ROOT / "build" / "_page2_raw"


def rasterise_pdf(pdf_path: Path, prefix: Path, dpi: int = 400) -> Path:
    prefix.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "pdftoppm",
        "-png",
        "-r",
        str(dpi),
        "-singlefile",
        str(pdf_path),
        str(prefix),
    ]
    subprocess.run(cmd, check=True)
    png_path = Path(f"{prefix}.png")
    if not png_path.exists():
        raise FileNotFoundError(f"Rasterisation failed: {png_path}")
    return png_path


def clean_document_scan(image_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

    # Smooth scanner streaks horizontally before estimating page background.
    streak_reduced = cv2.GaussianBlur(gray, (31, 1), 0)

    bg_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (61, 61))
    background = cv2.morphologyEx(streak_reduced, cv2.MORPH_OPEN, bg_kernel)
    background = cv2.GaussianBlur(background, (0, 0), 25)
    normalized = cv2.divide(streak_reduced, background, scale=255)

    denoised = cv2.bilateralFilter(normalized, d=7, sigmaColor=45, sigmaSpace=45)
    denoised = cv2.fastNlMeansDenoising(denoised, None, h=6, templateWindowSize=7, searchWindowSize=21)

    clahe = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)

    gamma = 1.12
    lut = np.array([((i / 255.0) ** (1.0 / gamma)) * 255 for i in range(256)], dtype=np.uint8)
    brightened = cv2.LUT(enhanced, lut)

    blur = cv2.GaussianBlur(brightened, (0, 0), 0.9)
    sharpened = cv2.addWeighted(brightened, 1.35, blur, -0.35, 0)
    cleaned = np.clip(sharpened, 0, 255).astype(np.uint8)

    return cv2.cvtColor(cleaned, cv2.COLOR_GRAY2BGR)


def save_pdf(image_bgr: np.ndarray, output_pdf: Path) -> None:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb)
    pil_image.save(output_pdf, "PDF", resolution=300.0)


def main() -> int:
    if not SOURCE.exists():
        print(f"Missing source PDF: {SOURCE}", file=sys.stderr)
        return 1

    print(f"Rasterising: {SOURCE}")
    raw_png = rasterise_pdf(SOURCE, TMP_PREFIX, dpi=400)

    image = cv2.imread(str(raw_png), cv2.IMREAD_COLOR)
    if image is None:
        print(f"Failed to read raster image: {raw_png}", file=sys.stderr)
        return 1

    cleaned = clean_document_scan(image)
    cv2.imwrite(str(OUTPUT_PNG), cleaned)
    save_pdf(cleaned, OUTPUT_PDF)
    save_pdf(cleaned, OUTPUT_SOURCE_CLEAN)

    print(f"Saved cleaned preview: {OUTPUT_PNG}")
    print(f"Saved cleaned PDF: {OUTPUT_PDF}")
    print(f"Saved cleaned source copy: {OUTPUT_SOURCE_CLEAN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
