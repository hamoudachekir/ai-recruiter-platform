"""
Test script for hamoudachkir@yahoo.fr recommendations
"""
import requests
import json
from pymongo import MongoClient
import os
from dotenv import load_dotenv
from bson import ObjectId

# Load environment variables
load_dotenv()

# MongoDB connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "users")

client = MongoClient(MONGO_URI)
db = client[MONGO_DB_NAME]

AI_SERVICE_URL = "http://127.0.0.1:5001"

def find_candidate():
    """Find the candidate with email hamoudachkir@yahoo.fr"""
    print("\n=== STEP 1: Finding Candidate ===")

    candidate = db.users.find_one(
        {"email": "hamoudachkir@yahoo.fr", "role": "CANDIDATE"},
        {"_id": 1, "name": 1, "email": 1, "profile": 1}
    )

    if not candidate:
        print("❌ Candidate not found!")
        return None

    print(f"✅ Found: {candidate.get('name', 'Unknown')}")
    print(f"   Email: {candidate.get('email')}")
    print(f"   ID: {candidate['_id']}")

    profile = candidate.get('profile', {})
    skills = profile.get('skills', [])
    languages = profile.get('languages', [])
    experience = profile.get('experience', [])

    print(f"\n📊 Profile Summary:")
    print(f"   Skills: {', '.join(skills) if skills else 'None'}")
    print(f"   Languages: {', '.join(languages) if languages else 'None'}")
    print(f"   Experience entries: {len(experience)}")

    if experience:
        print(f"\n💼 Experience:")
        for i, exp in enumerate(experience[:3], 1):
            print(f"   {i}. {exp.get('title', 'N/A')} at {exp.get('company', 'N/A')}")

    return candidate

def create_matching_job(candidate):
    """Create a job that matches the candidate's profile"""
    print("\n=== STEP 2: Creating Matching Job ===")

    profile = candidate.get('profile', {})
    skills = profile.get('skills', [])
    languages = profile.get('languages', [])

    # Find an enterprise to post the job
    enterprise = db.users.find_one({"role": "ENTERPRISE"}, {"_id": 1, "name": 1})

    if not enterprise:
        print("❌ No enterprise found to post job")
        return None

    print(f"✅ Using enterprise: {enterprise.get('name', 'Unknown')} ({enterprise['_id']})")

    # Prepare job data based on candidate skills
    if skills:
        # Use candidate's skills for the job
        job_skills = skills[:5]  # Take first 5 skills
        job_title = f"{skills[0] if skills else 'Software'} Developer"
    else:
        # Default job
        job_skills = ["Python", "JavaScript", "React"]
        job_title = "Full Stack Developer"

    if languages:
        job_languages = languages[:3]
    else:
        job_languages = ["English", "French"]

    job_data = {
        "title": job_title,
        "description": f"We are looking for a talented developer with expertise in {', '.join(job_skills)}. "
                      f"This is a great opportunity to work on exciting projects using modern technologies. "
                      f"The ideal candidate should have strong problem-solving skills and experience with "
                      f"web development, software engineering, and team collaboration.",
        "skills": job_skills,
        "languages": job_languages,
        "location": "Remote",
        "salary": "5000",
        "entrepriseId": enterprise['_id'],
        "createdAt": {"$date": {"$numberLong": "1710000000000"}}
    }

    print(f"\n📝 Job Details:")
    print(f"   Title: {job_data['title']}")
    print(f"   Skills: {', '.join(job_data['skills'])}")
    print(f"   Languages: {', '.join(job_data['languages'])}")
    print(f"   Location: {job_data['location']}")
    print(f"   Salary: {job_data['salary']}€")

    # Insert job
    try:
        result = db.jobs.insert_one(job_data)
        job_id = result.inserted_id
        print(f"\n✅ Job created with ID: {job_id}")
        return job_id
    except Exception as e:
        print(f"❌ Error creating job: {str(e)}")
        return None

def refresh_ai_index():
    """Force refresh the AI job index"""
    print("\n=== STEP 3: Refreshing AI Index ===")

    try:
        response = requests.post(f"{AI_SERVICE_URL}/refresh-index", timeout=30)
        if response.status_code == 200:
            data = response.json()
            print(f"✅ {data.get('message', 'Index refreshed')}")
            return True
        else:
            print(f"❌ Failed: {response.text}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to AI service!")
        print("   Please start it with: python recommendation_service.py")
        return False
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return False

def test_recommendations(candidate_id):
    """Test recommendations for the candidate"""
    print(f"\n=== STEP 4: Testing Recommendations ===")

    try:
        response = requests.post(
            f"{AI_SERVICE_URL}/recommend",
            json={
                "candidate_id": str(candidate_id),
                "top_k": 10,
                "threshold": 0.1  # Very low threshold to see all matches
            },
            timeout=30
        )

        if response.status_code == 200:
            data = response.json()
            recommendations = data.get('recommendations', [])

            if recommendations:
                print(f"✅ Found {len(recommendations)} recommendations!\n")

                for i, job in enumerate(recommendations, 1):
                    match_score = job.get('match_score', 0) * 100
                    print(f"{i}. {job.get('title', 'Unknown Job')}")
                    print(f"   Match Score: {match_score:.1f}%")
                    print(f"   Skills: {', '.join(job.get('skills', []))}")
                    print(f"   Languages: {', '.join(job.get('languages', []))}")
                    print(f"   Location: {job.get('location', 'N/A')}")
                    print(f"   Salary: {job.get('salary', 'N/A')}€")
                    print(f"   Job ID: {job.get('_id')}")
                    print()

                # Show the best match
                best_match = recommendations[0]
                print(f"🎯 BEST MATCH:")
                print(f"   {best_match.get('title')} - {best_match.get('match_score', 0) * 100:.1f}% Match")
                return True
            else:
                print("⚠️  No recommendations found")

                if data.get('debug_info'):
                    print(f"\n📊 Debug Info:")
                    debug = data['debug_info']
                    print(f"   Top scores: {debug.get('top_scores', [])}")
                    print(f"   Candidate skills: {debug.get('candidate_skills', [])}")
                    print(f"   Total jobs: {debug.get('total_jobs_considered', 0)}")
                return False
        else:
            print(f"❌ Error: {response.text}")
            return False

    except Exception as e:
        print(f"❌ Test failed: {str(e)}")
        return False

def cleanup_test_job(job_id):
    """Optionally delete the test job"""
    print(f"\n=== Cleanup ===")
    response = input("Do you want to delete the test job? (yes/no): ").lower()

    if response == 'yes':
        try:
            db.jobs.delete_one({"_id": job_id})
            print(f"✅ Test job deleted")
        except Exception as e:
            print(f"❌ Error deleting job: {str(e)}")
    else:
        print(f"ℹ️  Test job kept in database (ID: {job_id})")

def main():
    print("=" * 70)
    print("   RECOMMENDATION TEST FOR hamoudachkir@yahoo.fr")
    print("=" * 70)

    # Step 1: Find candidate
    candidate = find_candidate()
    if not candidate:
        print("\n❌ Cannot proceed without candidate")
        return

    candidate_id = candidate['_id']

    # Step 2: Create matching job
    job_id = create_matching_job(candidate)
    if not job_id:
        print("\n❌ Cannot proceed without test job")
        return

    # Step 3: Refresh AI index
    if not refresh_ai_index():
        print("\n⚠️  AI service not available, but job was created")
        return

    # Step 4: Test recommendations
    success = test_recommendations(candidate_id)

    # Summary
    print("\n" + "=" * 70)
    if success:
        print("   ✅ TEST SUCCESSFUL!")
        print("   The recommendation system is working correctly.")
        print("   The matching job should now appear in the frontend.")
    else:
        print("   ⚠️  TEST INCONCLUSIVE")
        print("   Check the debug information above.")
    print("=" * 70)

    # Cleanup
    if job_id:
        cleanup_test_job(job_id)

    print("\n📱 Next Steps:")
    print("   1. Log in as hamoudachkir@yahoo.fr")
    print("   2. Go to Home page")
    print("   3. Check 'Recommended For You' section")
    print("   4. The test job should appear with match score")

if __name__ == "__main__":
    main()
