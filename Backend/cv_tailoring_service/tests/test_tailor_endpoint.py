from fastapi.testclient import TestClient
from app import main
from app.schema import TailorResponse, TailoredCv, Verification
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
