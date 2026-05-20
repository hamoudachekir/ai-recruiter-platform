"""Deep check of ID relationships."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import db, _client
from bson.objectid import ObjectId

def main():
    users_db = _client["ai_recruiter"]
    callrooms_col = users_db["callrooms"]

    jobs_col = db["video_analysis_jobs"]

    # Get all room IDs
    room_oids = [r['_id'] for r in callrooms_col.find({}, {'_id': 1})]
    room_roomIds = [r.get('roomId') for r in callrooms_col.find({}, {'roomId': 1}) if r.get('roomId')]

    print(f"Total rooms: {len(room_oids)}")
    print(f"Room _id samples: {[str(r) for r in room_oids[:3]]}")
    print(f"Room roomId samples: {room_roomIds[:3]}")

    # Get all job interviewIds
    job_interview_ids = [j.get('interviewId') for j in jobs_col.find({}, {'interviewId': 1}) if j.get('interviewId')]

    print(f"\nTotal jobs with interviewId: {len(job_interview_ids)}")
    print(f"InterviewId samples: {job_interview_ids[:5]}")

    # Check for matches
    print("\n" + "=" * 60)
    print("MATCHING CHECK")
    print("=" * 60)

    # Convert job interviewIds to ObjectIds where possible
    job_oids = []
    for jid in job_interview_ids[:10]:
        try:
            job_oids.append(ObjectId(jid))
        except:
            pass

    print(f"\nJob interviewIds that are valid ObjectIds: {len(job_oids)}")

    # Check if any match room _ids
    matches = set(room_oids) & set(job_oids)
    print(f"Matches with room _id: {len(matches)}")

    # Check if any match room roomIds
    job_id_set = set(job_interview_ids)
    room_id_set = set(room_roomIds)
    str_matches = job_id_set & room_id_set
    print(f"Matches with roomId: {len(str_matches)}")

    if matches:
        print("\n✅ Found matching ObjectIds:")
        for m in list(matches)[:3]:
            print(f"  {m}")
            job = jobs_col.find_one({'interviewId': str(m)})
            room = callrooms_col.find_one({'_id': m})
            if job and room:
                print(f"    Job status: {job.get('status')}")
                print(f"    Room candidate: {room.get('candidate')}")

    if str_matches:
        print("\n✅ Found matching roomIds:")
        for m in list(str_matches)[:3]:
            print(f"  {m}")

    if not matches and not str_matches:
        print("\n❌ No matches found - jobs and rooms are disconnected!")
        print("\nPossible causes:")
        print("  1. Jobs were created for deleted rooms")
        print("  2. Server and analysis service use different databases")
        print("  3. interviewId format changed over time")
        print("  4. Test data exists in analysis DB without matching rooms")

    # Check if any rooms have jobs
    print("\n" + "=" * 60)
    print("REVERSE CHECK: Rooms with matching jobs")
    print("=" * 60)

    for room in callrooms_col.find().limit(5):
        room_oid = str(room['_id'])
        room_id = room.get('roomId')

        job_by_oid = jobs_col.find_one({'interviewId': room_oid})
        job_by_room_id = jobs_col.find_one({'interviewId': room_id}) if room_id else None

        if job_by_oid or job_by_room_id:
            print(f"\n✅ Room {room_oid[:8]}... has job:")
            if job_by_oid:
                print(f"  By _id: {job_by_oid.get('status')}")
            if job_by_room_id:
                print(f"  By roomId: {job_by_room_id.get('status')}")
        else:
            print(f"\n❌ Room {room_oid[:8]}... / {room_id} has no matching job")

if __name__ == "__main__":
    main()
