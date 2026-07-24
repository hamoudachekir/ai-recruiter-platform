"""Remove trailing blank page(s) from the compiled report PDF."""

from __future__ import annotations

import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def is_blank(page) -> bool:
    text = (page.extract_text() or "").strip()
    if text:
        return False
    contents = page.get_contents()
    if contents is None:
        return True
    try:
        if isinstance(contents, list):
            data = b"".join(c.get_data() for c in contents)
        else:
            data = contents.get_data()
    except Exception:
        return False
    # Tiny content stream ≈ empty page (footer-only pages still have content).
    return len(data) < 80


def trim(path: Path) -> int:
    reader = PdfReader(str(path))
    pages = list(reader.pages)
    removed = 0
    while len(pages) > 1 and is_blank(pages[-1]):
        pages.pop()
        removed += 1
    if removed == 0:
        print(f"{path.name}: no trailing blank page")
        return 0

    writer = PdfWriter()
    for page in pages:
        writer.add_page(page)
    tmp = path.with_name(path.stem + "_trim_tmp.pdf")
    with open(tmp, "wb") as handle:
        writer.write(handle)
    tmp.replace(path)
    print(f"{path.name}: removed {removed} trailing blank page(s), now {len(pages)} pages")
    return removed


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "build/main.pdf")
    if not target.exists():
        print(f"Missing PDF: {target}", file=sys.stderr)
        return 1
    trim(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
