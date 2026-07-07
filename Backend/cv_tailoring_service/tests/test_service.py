import pytest
from app import service
from app.schema import TailoredCv, Verification

CV = {"name": "Ada", "profile": {"skills": ["Python"], "experience": []}, "education": []}

def _tailored(summary="s"):
    return TailoredCv(summary=summary, experiences=[], skills=["Python"], education=[], changes_applied=["x"])

def test_run_tailor_happy(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev", "skills": ["Python"]})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=True, retried=retried))
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.verification.passed is True
    assert resp.changes_applied == ["x"]

def test_run_tailor_retries_then_passes(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    def fake_verify(cv, t, retried=False):
        calls["n"] += 1
        return Verification(passed=calls["n"] > 1, invented_entities=[] if calls["n"] > 1 else ["google"], retried=retried)
    monkeypatch.setattr(service, "verify", fake_verify)
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.verification.passed is True
    assert resp.verification.retried is True

def test_run_tailor_advisory_when_still_flagged(monkeypatch):
    # Advisory, not blocking: still returns the tailored CV with passed=False.
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=False, invented_entities=["google"], retried=retried))
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.verification.passed is False
    assert resp.verification.retried is True
    assert resp.verification.invented_entities == ["google"]

def test_run_tailor_job_not_found(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: None)
    with pytest.raises(service.JobNotFound):
        service.run_tailor("c1", "bad", CV)

def test_run_tailor_with_pasted_job_text_skips_db(monkeypatch):
    # Pasted JD: keywords come from the text; get_job must NOT be called.
    def boom(jid):
        raise AssertionError("get_job should not be called when job_text is provided")
    captured = {}
    def fake_keywords(job, top_k=20):
        captured["job"] = job
        return ["react"]
    monkeypatch.setattr(service, "get_job", boom)
    monkeypatch.setattr(service, "extract_keywords", fake_keywords)
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=True, retried=retried))
    resp = service.run_tailor("c1", "any-id", CV, job_text="We need a React developer with Docker")
    assert resp.verification.passed is True
    assert "React developer" in captured["job"]["description"]

def test_run_tailor_returns_keywords(monkeypatch):
    # The JD keywords are returned so the client can compute a match score.
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["react", "docker"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=True, retried=retried))
    resp = service.run_tailor("c1", "j1", CV)
    assert resp.keywords == ["react", "docker"]

def test_run_tailor_no_job_id_uses_job_text(monkeypatch):
    # Standalone profile-tab entry point: no platform job at all.
    def boom(jid):
        raise AssertionError("get_job should not be called when job_text is provided")
    monkeypatch.setattr(service, "get_job", boom)
    monkeypatch.setattr(service, "extract_keywords", lambda job, top_k=20: ["python"])
    monkeypatch.setattr(service, "tailor_cv", lambda cv, kw, extra_instruction="": _tailored())
    monkeypatch.setattr(service, "verify", lambda cv, t, retried=False: Verification(passed=True, retried=retried))
    resp = service.run_tailor("c1", None, CV, job_text="We need a React developer")
    assert resp.verification.passed is True

def test_run_tailor_neither_job_id_nor_text_raises(monkeypatch):
    monkeypatch.setattr(service, "get_job", lambda jid: {"title": "Dev"})
    with pytest.raises(service.NoJobSpecified):
        service.run_tailor("c1", None, CV, job_text=None)
