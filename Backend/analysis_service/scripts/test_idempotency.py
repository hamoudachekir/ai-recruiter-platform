"""Test job idempotency by simulating duplicate analysis requests."""
import sys
sys.path.insert(0, '.')

from datetime import datetime, timezone
from app.db.mongo import jobs_col, reports_col
from app.api.routes_analysis import _check_existing_job, _atomic_start_job

def test_idempotency(interview_id):
    print(f"Testing idempotency for interview: {interview_id}")
    print("=" * 70)

    # Test 1: Check existing job (should find completed job)
    print("\n1. Checking existing job status...")
    existing, should_start = _check_existing_job(interview_id, force=False)

    if existing:
        print(f"   ✅ Found existing job: {existing.get('status')}")
        print(f"   Should start new analysis: {should_start}")

        if existing.get('status') == 'completed' and not should_start:
            print("   ✅ Idempotency working: Won't restart completed job without force")
    else:
        print("   ⚠️ No existing job found")

    # Test 2: Check with force=True
    print("\n2. Checking with force=True...")
    existing, should_start = _check_existing_job(interview_id, force=True)
    print(f"   Should start new analysis with force=True: {should_start}")

    if should_start:
        print("   ✅ Force flag allows rerun")

    # Test 3: Check report exists
    print("\n3. Checking for existing report...")
    report = reports_col.find_one({"interviewId": interview_id}, {"_id": 0, "interviewId": 1, "generatedAt": 1})
    if report:
        print(f"   ✅ Report exists (generated: {report.get('generatedAt')})")
    else:
        print("   ❌ No report found")

    # Test 4: Simulate atomic job start
    print("\n4. Simulating atomic job start...")
    job = _atomic_start_job(interview_id)
    print(f"   ✅ Job started/updated: {job.get('status')}")
    print(f"   Job ID: {job.get('_id')}")

    # Show current job state
    print("\n5. Current job state in database:")
    current_job = jobs_col.find_one({"interviewId": interview_id}, {"_id": 0})
    if current_job:
        print(f"   Status: {current_job.get('status')}")
        print(f"   Progress: {current_job.get('progress')}%")
        print(f"   Current step: {current_job.get('currentStep')}")
        print(f"   Updated at: {current_job.get('updatedAt')}")
        if current_job.get('attempts'):
            print(f"   Attempts: {len(current_job.get('attempts', []))}")

    print("\n" + "=" * 70)
    print("IDEMPOTENCY TEST COMPLETE")
    print("=" * 70)
    print("\nExpected behavior:")
    print("- First call with force=false on completed job → returns existing")
    print("- Second call with force=true → allows restart")
    print("- Atomic start updates job status and tracks attempts")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/test_idempotency.py <interviewId>")
        sys.exit(1)
    test_idempotency(sys.argv[1])
