"""
Complete end-to-end test for the job recommendation system.
  1. Inserts a test enterprise + job into MongoDB
  2. Inserts a test candidate with a matching profile
  3. Starts recommendation_service.py
  4. Calls GET /recommend and prints the results
  5. Cleans up test data when done
"""
import os
import sys
# Force UTF-8 output on Windows to avoid cp1252 encoding errors
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import time
import json
import subprocess
import requests
from pymongo import MongoClient
from bson import ObjectId
import bcrypt

# ─────────────────────────────────────────────
MONGO_URI    = "mongodb://localhost:27017/users"
DB_NAME      = "users"
SERVICE_PORT = 5001
SERVICE_URL  = f"http://127.0.0.1:{SERVICE_PORT}/recommend"
AI_DIR       = os.path.dirname(os.path.abspath(__file__))
VENV_PYTHON  = os.path.join(AI_DIR, "..", "..", "..", ".venv", "Scripts", "python.exe")
# ─────────────────────────────────────────────

client = MongoClient(MONGO_URI)
db     = client[DB_NAME]

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def log(msg, color=RESET):    print(f"{color}{msg}{RESET}")
def ok(msg):                  log(f"  [OK] {msg}", GREEN)
def err(msg):                 log(f"  [ERR] {msg}", RED)
def info(msg):                log(f"  [..] {msg}", CYAN)
def section(title):           log(f"\n{BOLD}{'='*55}\n  {title}\n{'='*55}{RESET}", YELLOW)

# ───────────────────────────────────────────── cleanup helpers
inserted_ids = {"enterprise": None, "candidate": None, "job": None}

def cleanup():
    section("CLEANUP — removing test data")
    users = db["users"]
    jobs  = db["jobs"]
    if inserted_ids["enterprise"]:
        users.delete_one({"_id": inserted_ids["enterprise"]})
        ok(f"Deleted enterprise  {inserted_ids['enterprise']}")
    if inserted_ids["candidate"]:
        users.delete_one({"_id": inserted_ids["candidate"]})
        ok(f"Deleted candidate   {inserted_ids['candidate']}")
    if inserted_ids["job"]:
        jobs.delete_one({"_id": inserted_ids["job"]})
        ok(f"Deleted job         {inserted_ids['job']}")

# ────────────────────────────────────────────  STEP 1 — enterprise + job
def step1_create_enterprise_and_job():
    section("STEP 1 — Create Enterprise + Job")

    # --- enterprise user
    hashed_pw = bcrypt.hashpw(b"Test@1234", bcrypt.gensalt()).decode()
    enterprise_doc = {
        "_id": ObjectId(),
        "name": "TechNova Corp",
        "email": "technova_test@nexthire.io",
        "password": hashed_pw,
        "role": "ENTERPRISE",
        "isActive": True,
        "verificationStatus": {"status": "APPROVED", "emailVerified": True},
        "enterprise": {
            "name": "TechNova Corp",
            "industry": "Software",
            "location": "Tunis, Tunisia",
            "description": "AI-driven software solutions",
            "website": "https://technova.io",
            "employeeCount": 120,
        },
        "jobsPosted": [],
    }
    db["users"].insert_one(enterprise_doc)
    inserted_ids["enterprise"] = enterprise_doc["_id"]
    ok(f"Enterprise created  id={enterprise_doc['_id']}")

    # --- job matching a Python / ML developer
    job_doc = {
        "_id": ObjectId(),
        "title": "Senior Python & Machine Learning Engineer",
        "description": (
            "We are looking for a senior software engineer with strong Python and "
            "machine learning expertise. You will design and deploy ML pipelines, "
            "build REST APIs with Flask/FastAPI, and work with our data team."
        ),
        "location": "Tunis, Tunisia",
        "salary": 4500,
        "languages": ["English", "French"],
        "skills": ["Python", "Machine Learning", "TensorFlow", "Flask", "REST API",
                   "scikit-learn", "Docker", "SQL"],
        "entrepriseId": enterprise_doc["_id"],
        "status": "OPEN",
    }
    db["jobs"].insert_one(job_doc)
    inserted_ids["job"] = job_doc["_id"]
    ok(f"Job created         id={job_doc['_id']}")
    info(f"Job title: {job_doc['title']}")
    return enterprise_doc, job_doc

# ───────────────────────────────────────────── STEP 2 — candidate
def step2_create_candidate():
    section("STEP 2 — Create Candidate with matching profile")

    hashed_pw = bcrypt.hashpw(b"Cand@1234", bcrypt.gensalt()).decode()
    candidate_doc = {
        "_id": ObjectId(),
        "name": "Aymen Ben Salah",
        "email": "aymen_test@nexthire.io",
        "password": hashed_pw,
        "role": "CANDIDATE",
        "isActive": True,
        "domain": "Artificial Intelligence / Machine Learning",
        "verificationStatus": {"status": "APPROVED", "emailVerified": True},
        "profile": {
            "resume": (
                "Machine learning engineer with 4 years of experience building "
                "end-to-end AI solutions using Python, TensorFlow, scikit-learn and Flask. "
                "Passionate about NLP and computer vision applications."
            ),
            "shortDescription": "ML Engineer | Python | TensorFlow | Flask",
            "skills": ["Python", "TensorFlow", "scikit-learn", "Flask", "Docker",
                       "SQL", "REST API", "Machine Learning", "NLP", "Git"],
            "phone": "+21650123456",
            "languages": ["English", "French", "Arabic"],
            "availability": "Full-time",
            "domain": "Artificial Intelligence / Machine Learning",
            "experience": [
                {
                    "title": "Machine Learning Engineer",
                    "company": "DataBridge",
                    "duration": "2022 – 2024",
                    "description": (
                        "Built NLP classification models using BERT and scikit-learn. "
                        "Deployed ML APIs with Flask and Docker on AWS."
                    ),
                },
                {
                    "title": "Python Backend Developer",
                    "company": "SoftLogic",
                    "duration": "2020 – 2022",
                    "description": (
                        "Developed REST APIs with Flask and SQLAlchemy. "
                        "Maintained CI/CD pipelines with Jenkins and Docker."
                    ),
                },
            ],
        },
    }
    db["users"].insert_one(candidate_doc)
    inserted_ids["candidate"] = candidate_doc["_id"]
    ok(f"Candidate created   id={candidate_doc['_id']}")
    info(f"Skills: {', '.join(candidate_doc['profile']['skills'])}")
    return candidate_doc

# ───────────────────────────────────────────── STEP 3 — start service
def step3_start_service():
    section("STEP 3 — Start recommendation_service.py")

    python_exe = os.path.normpath(VENV_PYTHON)
    if not os.path.exists(python_exe):
        # fallback to system python
        python_exe = sys.executable
        info(f"venv python not found, using: {python_exe}")

    env = os.environ.copy()
    env["MONGO_URI"]     = MONGO_URI
    env["MONGO_DB_NAME"] = DB_NAME

    service_script = os.path.join(AI_DIR, "recommendation_service.py")
    proc = subprocess.Popen(
        [python_exe, service_script],
        env=env,
        cwd=AI_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    info("Waiting for Flask service to start…")
    for _ in range(20):
        time.sleep(1)
        try:
            requests.get(f"http://127.0.0.1:{SERVICE_PORT}/", timeout=1)
            ok("Recommendation service is UP")
            return proc
        except Exception:
            pass
    # service has no GET /, just check if process is alive
    if proc.poll() is None:
        ok("Service process running (no health endpoint)")
    else:
        out, err_out = proc.communicate()
        err(f"Service failed to start:\n{err_out.decode()[:500]}")
    return proc

# ───────────────────────────────────────────── STEP 4 — call API
def step4_test_recommendation(candidate_id):
    section("STEP 4 — Call /recommend endpoint")

    payload = {"candidate_id": str(candidate_id), "top_k": 5}
    info(f"POST {SERVICE_URL}")
    info(f"Payload: {json.dumps(payload)}")

    try:
        resp = requests.post(SERVICE_URL, json=payload, timeout=30)
    except requests.exceptions.ConnectionError:
        err("Cannot connect to recommendation service. Is it running?")
        return

    info(f"HTTP Status: {resp.status_code}")

    if resp.status_code != 200:
        err(f"Error response: {resp.text[:400]}")
        return

    data = resp.json()
    recs = data.get("recommendations", [])

    if not recs:
        log(f"\n  {RED}No recommendations returned.{RESET}")
        log(f"  Raw response: {json.dumps(data, indent=2, default=str)[:600]}")
        return

    log(f"\n  {GREEN}{BOLD}Recommendations ({len(recs)} result(s)):{RESET}")
    for i, job in enumerate(recs, 1):
        score_pct = round(job.get("match_score", 0) * 100, 1)
        log(f"\n  {BOLD}#{i}  {job.get('title')}{RESET}")
        log(f"      Job ID      : {job.get('_id')}")
        log(f"      Location    : {job.get('location', 'N/A')}")
        log(f"      Salary      : {job.get('salary', 'N/A')}")
        log(f"      Match score : {GREEN}{score_pct}%{RESET}")
        skills = job.get("skills", [])
        if skills:
            log(f"      Skills      : {', '.join(skills)}")

# ───────────────────────────────────────────── MAIN
def main():
    log(f"\n{BOLD}{CYAN}╔══════════════════════════════════════════════╗")
    log(f"║  Next Hire — Recommendation Full-Stack Test  ║")
    log(f"╚══════════════════════════════════════════════╝{RESET}\n")

    proc = None
    try:
        enterprise, job = step1_create_enterprise_and_job()
        candidate        = step2_create_candidate()
        proc             = step3_start_service()

        # give it one extra second to load the embedding model
        info("Waiting 3 s for model to be ready…")
        time.sleep(3)

        step4_test_recommendation(candidate["_id"])

    except KeyboardInterrupt:
        log("\n  Interrupted by user.", YELLOW)
    except Exception as e:
        err(f"Unexpected error: {e}")
        import traceback; traceback.print_exc()
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            ok("Service process terminated")
        cleanup()
        log(f"\n{BOLD}Test complete.{RESET}\n")

if __name__ == "__main__":
    main()
