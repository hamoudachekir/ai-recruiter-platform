"""Find available interview videos."""
import sys
sys.path.insert(0, '.')

import os
from pathlib import Path
from app.core.config import UPLOADS_DIR

def main():
    print("=" * 70)
    print("FINDING AVAILABLE VIDEOS")
    print("=" * 70)
    print(f"\nUploads directory: {UPLOADS_DIR}")
    print(f"Directory exists: {UPLOADS_DIR.exists()}")

    if not UPLOADS_DIR.exists():
        print("\n❌ Uploads directory does not exist!")
        return

    # List all files
    files = list(UPLOADS_DIR.iterdir())
    print(f"\nTotal files: {len(files)}")

    # Find video files
    video_extensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv']
    videos = [f for f in files if f.suffix.lower() in video_extensions]

    print(f"Video files: {len(videos)}")

    if videos:
        print("\nAvailable videos:")
        for v in videos[:10]:  # Show first 10
            size_mb = v.stat().st_size / (1024 * 1024)
            print(f"  📹 {v.name} ({size_mb:.1f} MB)")

            # Try to extract interview ID from filename
            # Common formats: interview_{id}.mp4, {id}.mp4, room-{timestamp}-{id}.mp4
            name = v.stem
            print(f"     Interview ID candidate: {name}")
    else:
        print("\n❌ No video files found!")
        print("\nYou need to upload a video first.")

    print("\n" + "=" * 70)

    # Also check the ai_recruiter database for rooms with video paths
    print("\nChecking database for rooms with videos...")

    from app.db.mongo import _client
    users_db = _client["ai_recruiter"]
    callrooms_col = users_db["callrooms"]

    rooms_with_videos = list(callrooms_col.find({
        "$or": [
            {"videoPath": {"$exists": True}},
            {"recordingUrl": {"$exists": True}},
            {"videoUrl": {"$exists": True}},
        ]
    }).limit(5))

    print(f"Rooms with video paths: {len(rooms_with_videos)}")

    for room in rooms_with_videos:
        print(f"\n  Room: {room.get('roomId') or room.get('_id')}")
        print(f"    videoPath: {room.get('videoPath')}")
        print(f"    recordingUrl: {room.get('recordingUrl')}")
        print(f"    videoUrl: {room.get('videoUrl')}")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
