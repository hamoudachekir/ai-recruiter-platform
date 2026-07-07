from app.schema import CvJson, TailoredCv, TailorRequest

SAMPLE_CV = {
    "name": "Ada Lovelace", "email": "ada@x.io", "phone": "+216 20 000 000",
    "role": "CANDIDATE", "domain": "Software",
    "profile": {
        "resume": "Engineer summary", "shortDescription": "short",
        "skills": ["Python", "SQL"], "phone": "+216 20 000 000",
        "languages": ["English", "French"], "availability": "Full-time",
        "domain": "Software",
        "experience": [
            {"title": "Dev", "company": "ACME", "duration": "2020-2022", "description": "Built things"}
        ],
    },
    "education": ["BSc Computer Science, University of Tunis, 2019"],
}

def test_cvjson_parses():
    cv = CvJson.model_validate(SAMPLE_CV)
    assert cv.name == "Ada Lovelace"
    assert cv.profile.skills == ["Python", "SQL"]
    assert cv.education == ["BSc Computer Science, University of Tunis, 2019"]

def test_tailor_request_parses():
    req = TailorRequest.model_validate({"candidate_id": "c1", "job_id": "j1", "cv_json": SAMPLE_CV})
    assert req.cv_json.profile.experience[0].company == "ACME"

def test_tailored_cv_defaults_lists():
    t = TailoredCv.model_validate({"summary": "s", "experiences": [], "skills": [], "education": [], "changes_applied": []})
    assert t.changes_applied == []
