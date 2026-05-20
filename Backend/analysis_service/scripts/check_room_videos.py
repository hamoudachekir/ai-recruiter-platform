"""Check which rooms have actual video files."""
import sys
sys.path.insert(0, '.')

import os
from pathlib import Path
from app.core.config import UPLOADS_DIR

def get_video_files(directory):
    """Get all video files in a directory."""
    if not directory.exists():
        return []

    video_extensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ogg']
    videos = []

    for item in directory.iterdir():
        if item.is_file() and item.suffix.lower() in video_extensions:
            videos.append(item)
        elif item.is_dir():
            # Check subdirectory
            videos.extend(get_video_files(item))

    return videos

def main():
    print("=" * 70)
    print("ROOMS WITH VIDEO FILES")
    print("=" * 70)
    print(f"\nScanning: {UPLOADS_DIR}")

    if not UPLOADS_DIR.exists():
        print("❌ Directory does not exist!")
        return

    # Check each subdirectory (room folder)
    rooms_with_videos = []

    for item in sorted(UPLOADS_DIR.iterdir()):
        if item.is_dir():
            videos = get_video_files(item)
            if videos:
                total_size = sum(v.stat().st_size for v in videos)
                total_size_mb = total_size / (1024 * 1024)

                rooms_with_videos.append({
                    'room_id': item.name,
                    'path': item,
                    'videos': videos,
                    'total_size_mb': total_size_mb,
                    'video_count': len(videos)
                })

    print(f"\nFound {len(rooms_with_videos)} rooms with videos:\n")

    for room in rooms_with_videos:
        print(f"📹 {room['room_id']}")
        print(f"   Videos: {room['video_count']}")
        print(f"   Total size: {room['total_size_mb']:.1f} MB")
        for v in room['videos']:
            size_mb = v.stat().st_size / (1024 * 1024)
            print(f"   - {v.name} ({size_mb:.1f} MB)")
        print()

    if rooms_with_videos:
        print("=" * 70)
        print("RECOMMENDED ROOMS FOR TESTING:")
        print("=" * 70)

        # Sort by size (largest first)
        sorted_rooms = sorted(rooms_with_videos, key=lambda x: x['total_size_mb'], reverse=True)

        for i, room in enumerate(sorted_rooms[:5], 1):
            print(f"\n{i}. {room['room_id']}")
            print(f"   Size: {room['total_size_mb']:.1f} MB")
            print(f"   Use this ID in the frontend for testing")
    else:
        print("\n❌ No rooms have video files!")
        print("\nYou need to:")
        print("1. Conduct an interview with video recording")
        print("2. Or upload a video manually to a room folder")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
