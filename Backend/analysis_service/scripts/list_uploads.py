"""List all files in uploads directory."""
import sys
sys.path.insert(0, '.')

import os
from pathlib import Path
from app.core.config import UPLOADS_DIR, BACKEND_DIR

def main():
    print("=" * 70)
    print("UPLOADS DIRECTORY CONTENTS")
    print("=" * 70)

    # Check main uploads dir
    print(f"\n📁 Main uploads dir: {UPLOADS_DIR}")
    print(f"   Exists: {UPLOADS_DIR.exists()}")

    if UPLOADS_DIR.exists():
        files = sorted(UPLOADS_DIR.iterdir(), key=lambda x: x.stat().st_size, reverse=True)
        print(f"   Files: {len(files)}")

        for f in files[:20]:
            size_mb = f.stat().st_size / (1024 * 1024) if f.is_file() else 0
            ftype = "📁" if f.is_dir() else "📄"
            print(f"   {ftype} {f.name} ({size_mb:.1f} MB)")

    # Check parent uploads dir (Backend/uploads)
    parent_uploads = BACKEND_DIR / "uploads"
    print(f"\n📁 Parent uploads dir: {parent_uploads}")
    print(f"   Exists: {parent_uploads.exists()}")

    if parent_uploads.exists():
        items = list(parent_uploads.iterdir())
        print(f"   Items: {len(items)}")
        for item in items:
            ftype = "📁" if item.is_dir() else "📄"
            print(f"   {ftype} {item.name}")

    # Check for recordings subdirectory
    recordings_dir = parent_uploads / "recordings"
    print(f"\n📁 Recordings dir: {recordings_dir}")
    print(f"   Exists: {recordings_dir.exists()}")

    if recordings_dir.exists():
        files = sorted(recordings_dir.iterdir(), key=lambda x: x.stat().st_size, reverse=True)
        print(f"   Files: {len(files)}")

        for f in files[:10]:
            size_mb = f.stat().st_size / (1024 * 1024) if f.is_file() else 0
            print(f"   📹 {f.name} ({size_mb:.1f} MB)")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
