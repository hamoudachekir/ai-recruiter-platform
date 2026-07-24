from fastapi.testclient import TestClient
from app import main
from app.schema import ApplicationRecord, FitAnalysis, TailorResponse, TailoredCv, Verification
from app import service

client = TestClient(main.app)

CV = {"name": "Ada", "profile": {"skills": ["Python"], "experience": []}, "education": []}

def test_tailor_ok(monkeypatch):
    resp = TailorResponse(tailored_cv_json=TailoredCv(summary="s", changes_applied=["c"]), changes_applied=["c"], verification=Verification(passed=True))
    monkeypatch.setattr(main, "run_tailor", lambda *a, **k: resp)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 200
    assert r.json()["verification"]["passed"] is True

def test_tailor_rejected_422(monkeypatch):
    def boom(*a, **k):
        raise service.TailorRejected(Verification(passed=False, invented_entities=["google"]))
    monkeypatch.setattr(main, "run_tailor", boom)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 422
    assert r.json()["detail"]["invented_entities"] == ["google"]

def test_tailor_job_not_found_404(monkeypatch):
    def boom(*a, **k):
        raise service.JobNotFound("j1")
    monkeypatch.setattr(main, "run_tailor", boom)
    r = client.post("/tailor", json={"candidate_id": "c1", "job_id": "j1", "cv_json": CV})
    assert r.status_code == 404


def test_analyze_saves_result(monkeypatch):
    analysis = FitAnalysis(score=80, recommendation="apply", matched_skills=["Python"])
    application = ApplicationRecord(
        id=7,
        candidate_id="c1",
        job_title="Backend Engineer",
        company="ACME",
        source_url="",
        job_text="We need a Python backend engineer.",
        score=80,
        recommendation="apply",
        status="discovered",
        created_at="2026-07-21T12:00:00Z",
        updated_at="2026-07-21T12:00:00Z",
    )
    monkeypatch.setattr(main, "analyze_fit", lambda *args: analysis)
    monkeypatch.setattr(main, "save_analysis", lambda **kwargs: application)

    r = client.post("/analyze", json={
        "candidate_id": "c1",
        "cv_json": CV,
        "job_text": "We need a Python backend engineer.",
        "job_title": "Backend Engineer",
        "company": "ACME",
    })

    assert r.status_code == 200
    assert r.json()["analysis"]["score"] == 80
    assert r.json()["application_id"] == 7


def test_cover_letter_endpoint(monkeypatch):
    monkeypatch.setattr(main, "generate_cover_letter", lambda **kwargs: "Generated letter")
    r = client.post("/cover-letter", json={
        "cv_json": CV,
        "job_text": "We need a Python backend engineer.",
        "language": "en",
    })
    assert r.status_code == 200
    assert r.json() == {"content": "Generated letter", "language": "en"}
