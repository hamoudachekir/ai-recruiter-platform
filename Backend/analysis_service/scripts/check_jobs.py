"""Check jobs and their interview IDs."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import _client, db

def main():
    # Check analysis service database
    print("Jobs in analysis service database:")
    print("=" * 60)

    jobs_col = db["video_analysis_jobs"]
    jobs = list(jobs_col.find({}, {
        'interviewId': 1,
        'status': 1,
        '_id': 1
    }).limit(10))

    print(f"Found {len(jobs)} jobs")

    for job in jobs:
        interview_id = job.get('interviewId')
        print(f"\nJob ID: {job.get('_id')}")
        print(f"Interview ID: {interview_id}")
        print(f"Status: {job.get('status')}")

        # Try to find matching room
        users_db = _client["ai_recruiter"]
        room = users_db["callrooms"].find_one({'roomId': interview_id})
        if room:
            print(f"✅ Found matching room")
        else:
            print(f"❌ No matching room found")

    print("\n" + "=" * 60)

if __name__ == "__main__":
    main()
