"""Check recording for the interview room."""
import sys
sys.path.insert(0, '.')

from pathlib import Path
from bson.objectid import ObjectId
from app.db.mongo import _client

def main():
    room_id = '69fb550f83a1260975d1bbe0'
    room_room_id = 'room-1778078991519-qtc02mr97'

    print("=" * 70)
    print("CHECKING VIDEO RECORDING")
    print("=" * 70)

    users_db = _client["ai_recruiter"]
    callrooms_col = users_db["callrooms"]

    room = callrooms_col.find_one({"_id": ObjectId(room_id)})

    if not room:
        print("❌ Room not found")
        return

    print(f"\n📋 Room Details:")
    print(f"   _id: {room.get('_id')}")
    print(f"   roomId: {room.get('roomId')}")
    print(f"   videoPath: {room.get('videoPath')}")
    print(f"   recordingUrl: {room.get('recordingUrl')}")
    print(f"   videoUrl: {room.get('videoUrl')}")
    print(f"   status: {room.get('status')}")

    # Check if there's a recording file anywhere
    recording_url = room.get('recordingUrl')
    if recording_url:
        print(f"\n📹 Recording URL found: {recording_url}")

        # Check Backend/uploads/recordings
        recordings_dir = Path("c:/Users/hamou/OneDrive/Desktop/talan/ai-recruiter-platform/Backend/uploads/recordings")

        if recordings_dir.exists():
            print(f"\n📁 Checking recordings directory...")

            # Look for files containing the room ID
            matching_files = [f for f in recordings_dir.iterdir() if room_room_id in f.name or room_id in f.name]

            if matching_files:
                print(f"✅ Found {len(matching_files)} recording file(s):")
                for f in matching_files:
                    size_mb = f.stat().st_size / (1024 * 1024)
                    print(f"   📹 {f.name} ({size_mb:.1f} MB)")
            else:
                print("❌ No recording files found for this room")
                print(f"\n📄 All files in recordings dir:")
                for f in list(recordings_dir.iterdir())[:10]:
                    print(f"   - {f.name}")
        else:
            print(f"❌ Recordings directory not found: {recordings_dir}")

    # Check if there's a direct video URL
    video_url = room.get('videoUrl')
    if video_url:
        print(f"\n📹 Video URL: {video_url}")

    # Check uploads/interviews for any subdirectory with this roomId
    from app.core.config import UPLOADS_DIR

    print(f"\n📁 Checking {UPLOADS_DIR}...")

    if UPLOADS_DIR.exists():
        # Look for any folder containing the roomId
        for subdir in UPLOADS_DIR.iterdir():
            if subdir.is_dir() and room_room_id in subdir.name:
                print(f"✅ Found folder: {subdir.name}")
                files = list(subdir.iterdir())
                print(f"   Files: {len(files)}")
                for f in files:
                    if f.is_file():
                        size_mb = f.stat().st_size / (1024 * 1024)
                        print(f"   📄 {f.name} ({size_mb:.1f} MB)")

    print("\n" + "=" * 70)
    print("SOLUTION OPTIONS:")
    print("=" * 70)
    print("\n1. If recording file exists but videoPath is null:")
    print("   → The video needs to be linked to the room")
    print("\n2. If no recording exists:")
    print("   → Interview needs to be re-recorded with video")
    print("\n3. Use a room that has video:")
    print("   → room-1778057279953-l0hmu8ldy (40.7 MB)")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
