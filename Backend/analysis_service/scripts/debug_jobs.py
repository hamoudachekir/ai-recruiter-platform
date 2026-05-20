"""Debug analysis jobs and their interview IDs."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import db, _client

def main():
    print("=" * 70)
    print("ANALYSIS SERVICE DATABASE")
    print("=" * 70)
    print(f"Connected to: {db.name}")
    print(f"Collections: {db.list_collection_names()}")

    print("\n" + "=" * 70)
    print("VIDEO ANALYSIS JOBS")
    print("=" * 70)

    jobs_col = db["video_analysis_jobs"]
    jobs = list(jobs_col.find().limit(5))

    print(f"Total jobs: {jobs_col.count_documents({})}")

    for job in jobs:
        print(f"\nJob ID: {job.get('_id')}")
        print(f"  interviewId: {job.get('interviewId')}")
        print(f"  status: {job.get('status')}")
        print(f"  createdAt: {job.get('createdAt')}")

    print("\n" + "=" * 70)
    print("AI_RECRUITER DATABASE (where callrooms live)")
    print("=" * 70)

    users_db = _client["ai_recruiter"]
    print(f"Collections: {users_db.list_collection_names()}")

    callrooms_col = users_db["callrooms"]
    rooms = list(callrooms_col.find().limit(5))

    print(f"\nTotal callrooms: {callrooms_col.count_documents({})}")

    for room in rooms:
        print(f"\nRoom _id: {room.get('_id')}")
        print(f"  roomId: {room.get('roomId')}")
        print(f"  candidate: {room.get('candidate')}")
        print(f"  job: {room.get('job')}")

    print("\n" + "=" * 70)
    print("ID MATCHING TEST")
    print("=" * 70)

    # Try to match job interviewIds to rooms
    for job in jobs[:3]:
        interview_id = job.get('interviewId')
        if interview_id:
            print(f"\nLooking for interviewId: {interview_id}")

            # Try by roomId
            room = callrooms_col.find_one({'roomId': interview_id})
            if room:
                print(f"  ✅ Found by roomId")
                continue

            # Try by _id (ObjectId)
            from bson.objectid import ObjectId
            try:
                room = callrooms_col.find_one({'_id': ObjectId(interview_id)})
                if room:
                    print(f"  ✅ Found by _id")
                    continue
            except:
                pass

            # Try by interviewId field
            room = callrooms_col.find_one({'interviewId': interview_id})
            if room:
                print(f"  ✅ Found by interviewId field")
                continue

            print(f"  ❌ Not found")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
