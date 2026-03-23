"""
Test script to verify the recommendation system is working correctly
"""
import requests
import json
from pymongo import MongoClient
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# MongoDB connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "users")

AI_SERVICE_URL = "http://127.0.0.1:5001"

def test_service_health():
    """Check if the AI service is running"""
    print("\n=== Testing AI Service Health ===")
    try:
        response = requests.get(f"{AI_SERVICE_URL}/health", timeout=5)
        if response.status_code == 200:
            data = response.json()
            print("✅ AI Service is running!")
            print(f"   Jobs indexed: {data.get('jobs_indexed', 0)}")
            print(f"   Last update: {data.get('last_update', 'N/A')}")
            return True
        else:
            print(f"❌ Service returned error: {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to AI service at http://127.0.0.1:5001")
        print("   Make sure to run: python recommendation_service.py")
        return False
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return False

def refresh_job_index():
    """Force refresh the job index"""
    print("\n=== Refreshing Job Index ===")
    try:
        response = requests.post(f"{AI_SERVICE_URL}/refresh-index", timeout=30)
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Index refreshed: {data.get('message', 'Success')}")
            return True
        else:
            print(f"❌ Failed to refresh: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Error refreshing index: {str(e)}")
        return False

def check_database():
    """Check MongoDB for jobs and candidates"""
    print("\n=== Checking Database ===")
    try:
        client = MongoClient(MONGO_URI)
        db = client[MONGO_DB_NAME]

        # Count jobs
        jobs_count = db.jobs.count_documents({})
        print(f"📊 Total jobs in database: {jobs_count}")

        # Show recent jobs
        recent_jobs = list(db.jobs.find({}, {"title": 1, "skills": 1, "languages": 1}).limit(5))
        if recent_jobs:
            print("\n🔍 Recent jobs:")
            for i, job in enumerate(recent_jobs, 1):
                print(f"   {i}. {job.get('title', 'Unknown')}")
                print(f"      Skills: {', '.join(job.get('skills', []))}")
                print(f"      Languages: {', '.join(job.get('languages', []))}")

        # Count candidates
        candidates_count = db.users.count_documents({"role": "CANDIDATE"})
        print(f"\n👥 Total candidates: {candidates_count}")

        # Show candidate with profile
        sample_candidate = db.users.find_one(
            {"role": "CANDIDATE", "profile.skills": {"$exists": True, "$ne": []}},
            {"name": 1, "profile.skills": 1, "profile.languages": 1}
        )

        if sample_candidate:
            print(f"\n📝 Sample Candidate Profile:")
            print(f"   Name: {sample_candidate.get('name', 'Unknown')}")
            skills = sample_candidate.get('profile', {}).get('skills', [])
            languages = sample_candidate.get('profile', {}).get('languages', [])
            print(f"   Skills: {', '.join(skills) if skills else 'None'}")
            print(f"   Languages: {', '.join(languages) if languages else 'None'}")
            print(f"   Candidate ID: {sample_candidate['_id']}")

            return str(sample_candidate['_id'])
        else:
            print("⚠️  No candidates with skills found")
            return None

    except Exception as e:
        print(f"❌ Database error: {str(e)}")
        return None

def test_recommendation(candidate_id):
    """Test recommendations for a specific candidate"""
    if not candidate_id:
        print("\n⚠️  Skipping recommendation test (no candidate ID)")
        return

    print(f"\n=== Testing Recommendations for Candidate {candidate_id} ===")
    try:
        response = requests.post(
            f"{AI_SERVICE_URL}/recommend",
            json={
                "candidate_id": str(candidate_id),
                "top_k": 10,
                "threshold": 0.2
            },
            timeout=30
        )

        if response.status_code == 200:
            data = response.json()
            recommendations = data.get('recommendations', [])

            if recommendations:
                print(f"✅ Found {len(recommendations)} recommendations:")
                for i, job in enumerate(recommendations[:5], 1):
                    match_score = job.get('match_score', 0) * 100
                    print(f"\n   {i}. {job.get('title', 'Unknown Job')}")
                    print(f"      Match Score: {match_score:.1f}%")
                    print(f"      Skills: {', '.join(job.get('skills', []))}")
                    print(f"      Location: {job.get('location', 'N/A')}")
            else:
                print("⚠️  No recommendations found")
                print("   This could mean:")
                print("   - Candidate profile doesn't match any jobs well")
                print("   - Match scores are below threshold (20%)")
                print("   - No jobs in database")

                if data.get('debug_info'):
                    print(f"\n   Debug Info:")
                    print(f"   - Top scores: {data['debug_info'].get('top_scores', [])}")
                    print(f"   - Candidate skills: {data['debug_info'].get('candidate_skills', [])}")
        else:
            print(f"❌ Error: {response.text}")
    except Exception as e:
        print(f"❌ Recommendation test failed: {str(e)}")

def main():
    print("=" * 60)
    print("   NEXTHIRE RECOMMENDATION SYSTEM DIAGNOSTIC")
    print("=" * 60)

    # Step 1: Check if service is running
    if not test_service_health():
        print("\n❌ AI Service is not running!")
        print("   Please start it with: python recommendation_service.py")
        return

    # Step 2: Refresh job index
    refresh_job_index()

    # Step 3: Check database
    candidate_id = check_database()

    # Step 4: Test recommendations
    if candidate_id:
        test_recommendation(candidate_id)

    print("\n" + "=" * 60)
    print("   DIAGNOSTIC COMPLETE")
    print("=" * 60)
    print("\n💡 Tips:")
    print("   - Make sure to add React/JavaScript skills to candidate profiles")
    print("   - Jobs need clear descriptions and skills")
    print("   - Refresh the page after adding new jobs")
    print("   - Check backend console for detailed logs")

if __name__ == "__main__":
    main()
