"""List available interviews from MongoDB."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import db, jobs_col, reports_col

def main():
    print("Fetching data from MongoDB...")
    print(f"Database: {db.name}")
    print(f"Collections: {db.list_collection_names()}")
    print()

    # Check for interviews in call_rooms collection
    call_rooms = list(db["callrooms"].find(
        {},
        {'_id': 0, 'interviewId': 1, 'candidateName': 1, 'jobTitle': 1, 'status': 1}
    ).limit(10))

    if call_rooms:
        print(f"Found {len(call_rooms)} call rooms (interviews):\n")
        print("-" * 70)
        for i, inv in enumerate(call_rooms, 1):
            interview_id = inv.get('interviewId', inv.get('_id', 'N/A'))
            candidate = inv.get('candidateName', 'Unknown')
            job = inv.get('jobTitle', 'N/A')
            status = inv.get('status', 'unknown')
            print(f"{i}. Interview ID: {interview_id}")
            print(f"   Candidate: {candidate}")
            print(f"   Job: {job}")
            print(f"   Status: {status}")
            print("-" * 70)
        print("\nUse any Interview ID above for testing.")
        return

    # Check for jobs with interviewId
    jobs = list(jobs_col.find(
        {},
        {'_id': 0, 'interviewId': 1, 'status': 1}
    ).limit(10))

    if jobs:
        print(f"Found {len(jobs)} analysis jobs:\n")
        print("-" * 70)
        for i, job in enumerate(jobs, 1):
            interview_id = job.get('interviewId', 'N/A')
            status = job.get('status', 'unknown')
            print(f"{i}. Interview ID: {interview_id} (Job status: {status})")
            print("-" * 70)
        print("\nUse any Interview ID above for testing.")
        return

    print("\nNo interviews or jobs found in database.")
    print("\nTo create a test interview:")
    print("  1. Use the frontend to create an interview")
    print("  2. Or provide a video file in: Backend/uploads/interviews/<interviewId>/raw/")
    print("  3. Then run: python -m app.services.report_graph <interviewId>")

if __name__ == "__main__":
    main()
