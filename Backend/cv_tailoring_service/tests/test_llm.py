import json
import httpx
from app import llm

FAKE = {"summary": "Reformulated", "experiences": [{"title": "Dev", "company": "ACME", "duration": "2020", "description": "did x"}],
        "skills": ["Python"], "education": ["BSc"], "changes_applied": ["reordered skills"]}

def test_tailor_cv_parses_response(monkeypatch):
    captured = {}
    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers")
        content = json.dumps(FAKE)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
    monkeypatch.setattr(llm.httpx, "post", fake_post)

    out = llm.tailor_cv({"name": "Ada", "profile": {"skills": ["Python"]}}, ["python", "sql"])
    assert out.summary == "Reformulated"
    assert out.changes_applied == ["reordered skills"]
    # request shape
    assert captured["url"].endswith("/chat/completions")
    assert captured["json"]["response_format"]["type"] == "json_schema"
    assert "Bearer" in captured["headers"]["Authorization"]
    # keywords are passed into the user message
    user_msg = captured["json"]["messages"][-1]["content"]
    assert "python" in user_msg.lower()

import pytest


def test_detect_language_french_and_english():
    fr = {"profile": {"experience": [{"description": "Conception d'un back-office avec des interfaces et une base de données"}]}}
    en = {"profile": {"experience": [{"description": "Built a back-office with the React framework and set up CI/CD"}]}}
    assert llm.detect_language(fr) == "fr"
    assert llm.detect_language(en) == "en"
    assert llm.detect_language({}) == "fr"  # empty defaults to fr


def test_user_message_states_target_language(monkeypatch):
    en_cv = {"profile": {"experience": [{"description": "Built and developed the web app with React and Docker"}]}}
    msg = llm._user_message(en_cv, ["react"], "")
    assert "ANGLAIS" in msg  # explicit target-language directive present
    fr_cv = {"profile": {"experience": [{"description": "Conception d'une application avec des API et une base"}]}}
    assert "FRANCAIS" in llm._user_message(fr_cv, ["react"], "")


def test_tailor_cv_retries_after_429(monkeypatch):
    calls = {"n": 0}
    def fake_post(url, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, json={"error": "rate limited"}, request=httpx.Request("POST", url))
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(FAKE)}}]}, request=httpx.Request("POST", url))
    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setattr(llm.time, "sleep", lambda *a, **k: None)
    out = llm.tailor_cv({"name": "Ada"}, ["python"])
    assert out.summary == "Reformulated"
    assert calls["n"] == 2


def test_tailor_cv_raises_after_persistent_failure(monkeypatch):
    def fake_post(url, **kwargs):
        return httpx.Response(400, json={"error": "bad schema"}, request=httpx.Request("POST", url))
    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setattr(llm.time, "sleep", lambda *a, **k: None)
    with pytest.raises(llm.LlmError):
        llm.tailor_cv({"name": "Ada"}, ["python"])


def test_tailor_cv_rate_limited_raises_specific(monkeypatch):
    def fake_post(url, **kwargs):
        return httpx.Response(429, json={"error": "rate"}, request=httpx.Request("POST", url))
    monkeypatch.setattr(llm.httpx, "post", fake_post)
    monkeypatch.setattr(llm.time, "sleep", lambda *a, **k: None)
    with pytest.raises(llm.LlmRateLimited):
        llm.tailor_cv({"name": "Ada"}, ["python"])
