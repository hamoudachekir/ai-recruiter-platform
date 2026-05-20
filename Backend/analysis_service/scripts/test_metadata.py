"""Test metadata resolution for a real interview."""
import sys
sys.path.insert(0, '.')

from app.services.interview_metadata import get_report_metadata, resolve_interview_metadata

def main():
    # Test with the working room ID (found to have matching job and candidate)
    interview_id = 'room-1778057279953-l0hmu8ldy'

    print(f"Testing metadata resolution for: {interview_id}")
    print("=" * 60)

    # Get full resolution
    resolved = resolve_interview_metadata(interview_id)

    print(f"Found room: {resolved['found']}")
    print(f"Candidate Name: {resolved['candidate_name'] or 'NOT FOUND'}")
    print(f"Candidate Email: {resolved['candidate_email'] or 'NOT FOUND'}")
    print(f"Job Title: {resolved['job_title'] or 'NOT FOUND'}")
    print(f"Job ID: {resolved['job_id'] or 'NOT FOUND'}")
    print(f"Application ID: {resolved['application_id'] or 'NOT FOUND'}")

    print("=" * 60)

    # Get formatted metadata
    metadata = get_report_metadata(interview_id)

    print("Formatted metadata (for report generation):")
    print(f"  candidate_name: {metadata['candidate_name']}")
    print(f"  candidate_email: {metadata['candidate_email']}")
    print(f"  job_title: {metadata['job_title']}")

    print("=" * 60)

    # Check if it's using real values or fallbacks
    if metadata['candidate_name'] == 'Candidate':
        print("⚠️ Using fallback candidate name (room may not have candidate assigned)")
    else:
        print(f"✅ Using real candidate name: {metadata['candidate_name']}")

    if metadata['job_title'] == 'Role':
        print("⚠️ Using fallback job title (room may not have job assigned)")
    else:
        print(f"✅ Using real job title: {metadata['job_title']}")

    print("\nMetadata resolution test complete!")

if __name__ == "__main__":
    main()
