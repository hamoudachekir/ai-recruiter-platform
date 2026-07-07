from fastapi.testclient import TestClient
from app import main
from app.rxresume_client import RxResumeError

CV = {"name": "Ada", "email": "a@x.io", "phone": "1", "domain": "Soft", "profile": {"languages": ["English"], "skills": ["Python"]}}
TAILORED = {"summary": "s", "experiences": [], "skills": ["Python"], "education": [], "changes_applied": []}
BODY = {"candidate_id": "c1", "job_id": "j1", "cv_json": CV, "tailored_cv_json": TAILORED}

client = TestClient(main.app)

def test_export_ok(monkeypatch):
    class FakeClient:
        def generate(self, cv, tailored, candidate_id, template=None):
            return "/uploads/tailored-cvs/x.pdf", "res-1"
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json=BODY)
    assert r.status_code == 200
    assert r.json()["pdf_path"] == "/uploads/tailored-cvs/x.pdf"
    assert r.json()["resume_id"] == "res-1"

def test_export_rxresume_down_502(monkeypatch):
    class FakeClient:
        def generate(self, *a, **k):
            raise RxResumeError("connection refused")
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json=BODY)
    assert r.status_code == 502

def test_export_passes_template_through(monkeypatch):
    captured = {}
    class FakeClient:
        def generate(self, cv, tailored, candidate_id, template=None):
            captured["template"] = template
            return "/uploads/tailored-cvs/x.pdf", "res-1"
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json={**BODY, "template": "onyx"})
    assert r.status_code == 200
    assert captured["template"] == "onyx"

def test_export_invalid_template_400(monkeypatch):
    class FakeClient:
        def generate(self, cv, tailored, candidate_id, template=None):
            raise ValueError(f"Unknown Reactive Resume template '{template}'")
    monkeypatch.setattr(main, "RxResumeClient", lambda: FakeClient())
    r = client.post("/export-pdf", json={**BODY, "template": "not-real"})
    assert r.status_code == 400
