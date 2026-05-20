"""Check specific interview details."""
import sys
sys.path.insert(0, '.')

from bson.objectid import ObjectId
from app.db.mongo import _client, db

def main():
    interview_id = '69fb550f83a1260975d1bbe0'

    print("=" * 70)
    print(f"CHECKING INTERVIEW: {interview_id}")
    print("=" * 70)

    # Check in ai_recruiter database (callrooms)
    users_db = _client["ai_recruiter"]
    callrooms_col = users_db["callrooms"]

    print("\n📁 Looking in ai_recruiter.callrooms collection...")

    # Try by _id
    try:
        room = callrooms_col.find_one({"_id": ObjectId(interview_id)})
        if room:
            print(f"✅ Found by _id")
            print(f"   roomId: {room.get('roomId')}")
            print(f"   candidate: {room.get('candidate')}")
            print(f"   videoPath: {room.get('videoPath')}")
            print(f"   recordingUrl: {room.get('recordingUrl')}")
        else:
            print("❌ Not found by _id")
    except Exception as e:
        print(f"❌ Error looking up by _id: {e}")

    # Try by roomId
    room_by_roomid = callrooms_col.find_one({"roomId": interview_id})
    if room_by_roomid:
        print(f"✅ Found by roomId")
    else:
        print("❌ Not found by roomId")

    # Check in analysis database (video_analysis_jobs)
    print("\n📁 Looking in analysis.video_analysis_jobs collection...")
    jobs_col = db["video_analysis_jobs"]

    try:
        job = jobs_col.find_one({"_id": ObjectId(interview_id)})
        if job:
            print(f"✅ Found job by _id")
            print(f"   interviewId: {job.get('interviewId')}")
            print(f"   status: {job.get('status')}")
            print(f"   videoPath: {job.get('videoPath')}")
        else:
            print("❌ No job found by _id")
    except Exception as e:
        print(f"❌ Error: {e}")

    # Try by interviewId field
    job_by_interview = jobs_col.find_one({"interviewId": interview_id})
    if job_by_interview:
        print(f"✅ Found job by interviewId field")
        print(f"   _id: {job_by_interview.get('_id')}")
        print(f"   status: {job_by_interview.get('status')}")
    else:
        print("❌ No job found by interviewId")

    # Check video file directly
    print("\n📹 Checking for video files...")
    from app.core.config import UPLOADS_DIR

    # Check if folder exists
    room_folder = UPLOADS_DIR / interview_id
    if room_folder.exists():
        print(f"✅ Folder exists: {room_folder}")
        files = list(room_folder.iterdir())
        print(f"   Files: {len(files)}")
        for f in files:
            size_mb = f.stat().st_size / (1024 * 1024) if f.is_file() else 0
            print(f"   - {f.name} ({size_mb:.1f} MB)")
    else:
        print(f"❌ Folder not found: {room_folder}")

    # Also check for any folder containing this ID
    print("\n🔍 Searching all upload folders...")
    if UPLOADS_DIR.exists():
        matching_folders = [f for f in UPLOADS_DIR.iterdir() if interview_id in f.name]
        if matching_folders:
            print(f"✅ Found {len(matching_folders)} matching folder(s)")
            for mf in matching_folders:
                print(f"   - {mf.name}")
        else:
            print("❌ No folders contain this ID")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
