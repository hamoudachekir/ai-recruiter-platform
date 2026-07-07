from app import db

def test_job_to_text_concatenates():
    job = {"title": "Backend Engineer", "description": "Build APIs", "skills": ["Python", "FastAPI"], "companyName": "ACME"}
    text = db.job_to_text(job)
    assert "Backend Engineer" in text
    assert "Build APIs" in text
    assert "Python" in text and "FastAPI" in text

def test_get_job_bad_id_returns_none(monkeypatch):
    # Invalid ObjectId must not raise — returns None.
    assert db.get_job("not-a-valid-objectid") is None
