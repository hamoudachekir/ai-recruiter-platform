import json, os
import httpx
import pytest
from app import rxresume_client
from app.rxresume_client import RxResumeClient, RxResumeError

BASE = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "rxresume_base.json"), encoding="utf-8"))
LOGIN_COOKIE_HEADERS = [
    ("set-cookie", "Authentication=tok-abc; Path=/; HttpOnly"),
    ("set-cookie", "Refresh=tok-refresh; Path=/; HttpOnly"),
]


class FakeHttp:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        status, payload, content, headers = self.responses.pop(0)
        req = httpx.Request(method, url)
        if content is not None:
            return httpx.Response(status, content=content, headers=headers or [], request=req)
        return httpx.Response(status, json=payload, headers=headers or [], request=req)


def _settings(upload_dir="/tmp/tailored"):
    class S:
        rxresume_url = "http://localhost:3000"
        rxresume_email = "admin@nexthire.local"
        rxresume_password = "secret"
        tailored_cv_upload_dir = upload_dir
    return S()


def test_assert_schema_raises_on_missing_keys():
    c = RxResumeClient(http=FakeHttp([]))
    with pytest.raises(RxResumeError):
        c.assert_schema({"basics": {}})  # no 'sections'


def test_login_captures_session_cookies(monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(200, {"status": "authenticated"}, None, LOGIN_COOKIE_HEADERS)])
    c = RxResumeClient(http=fake)
    c.login()
    assert c._cookies == {"Authentication": "tok-abc", "Refresh": "tok-refresh"}
    method, url, kwargs = fake.calls[0]
    assert method == "POST" and url.endswith("/api/auth/login")
    assert kwargs["json"] == {"identifier": "admin@nexthire.local", "password": "secret"}


def test_login_without_credentials_raises(monkeypatch):
    class Empty:
        rxresume_url = "http://localhost:3000"
        rxresume_email = ""
        rxresume_password = ""
        tailored_cv_upload_dir = "/tmp"
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: Empty())
    c = RxResumeClient(http=FakeHttp([]))
    with pytest.raises(RxResumeError):
        c.login()


def test_create_resume_returns_id_and_base_data(monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(201, {"id": "res-1", "data": BASE}, None, None)])
    c = RxResumeClient(http=fake)
    rid, data = c.create_resume("Ada — tailored")
    assert rid == "res-1"
    assert data == BASE
    method, url, kwargs = fake.calls[0]
    assert method == "POST" and url.endswith("/api/resume")
    assert kwargs["json"]["title"] == "Ada — tailored"
    assert kwargs["json"]["slug"]  # non-empty, url-safe


def test_export_pdf_returns_url(monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(200, {"url": "http://localhost:9000/default/x/resumes/y.pdf"}, None, None)])
    c = RxResumeClient(http=fake)
    url = c.export_pdf("res-1")
    assert url == "http://localhost:9000/default/x/resumes/y.pdf"


def test_download_fetches_bytes_without_app_auth(monkeypatch):
    # The storage URL is a different origin (MinIO); no cookies/headers needed.
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(200, None, b"%PDF-1.7 fake", None)])
    c = RxResumeClient(http=fake)
    content = c.download("http://localhost:9000/default/x.pdf")
    assert content == b"%PDF-1.7 fake"


def test_save_pdf_writes_file(tmp_path, monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings(str(tmp_path)))
    c = RxResumeClient(http=FakeHttp([]))
    path = c.save_pdf(b"%PDF-1.4 test", "cand-9")
    assert path.startswith("/uploads/tailored-cvs/")
    saved = os.path.join(str(tmp_path), os.path.basename(path))
    assert os.path.exists(saved)


def test_generate_full_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings(str(tmp_path)))
    fake = FakeHttp([
        (200, {"status": "authenticated"}, None, LOGIN_COOKIE_HEADERS),        # login
        (201, {"id": "res-1", "data": BASE}, None, None),                     # create_resume
        (200, {}, None, None),                                                 # update_resume (PATCH)
        (200, {"url": "http://localhost:9000/default/x.pdf"}, None, None),    # export_pdf
        (200, None, b"%PDF-1.7 real", None),                                  # download
    ])
    c = RxResumeClient(http=fake)
    cv = {"name": "Ada", "email": "a@x.io", "phone": "1", "domain": "Software",
          "profile": {"languages": ["English"], "skills": ["Python"]}}
    tailored = {"summary": "s", "experiences": [], "skills": ["Python"], "education": [], "changes_applied": []}
    pdf_path, resume_id = c.generate(cv, tailored, "cand-1")
    assert resume_id == "res-1"
    assert pdf_path.startswith("/uploads/tailored-cvs/")
    assert os.path.exists(os.path.join(str(tmp_path), os.path.basename(pdf_path)))
    # PATCH call sent the mapped data (with our summary), not the raw base.
    method, url, kwargs = fake.calls[2]
    assert method == "PATCH" and f"/api/resume/res-1" in url
    assert "s" in kwargs["json"]["data"]["sections"]["summary"]["content"]


def test_json_request_wraps_http_error(monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(500, {"error": "boom"}, None, None)])
    c = RxResumeClient(http=fake)
    with pytest.raises(RxResumeError):
        c.create_resume("Ada — tailored")


def test_json_request_wraps_bad_json_body(monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings())
    fake = FakeHttp([(200, None, b"not-json", None)])
    c = RxResumeClient(http=fake)
    with pytest.raises(RxResumeError):
        c.create_resume("Ada — tailored")

def test_generate_passes_template_into_mapping(tmp_path, monkeypatch):
    monkeypatch.setattr(rxresume_client, "get_settings", lambda: _settings(str(tmp_path)))
    fake = FakeHttp([
        (200, {"status": "authenticated"}, None, LOGIN_COOKIE_HEADERS),
        (201, {"id": "res-1", "data": BASE}, None, None),
        (200, {}, None, None),
        (200, {"url": "http://localhost:9000/default/x.pdf"}, None, None),
        (200, None, b"%PDF-1.7 real", None),
    ])
    c = RxResumeClient(http=fake)
    cv = {"name": "Ada", "email": "a@x.io", "phone": "1", "domain": "Software",
          "profile": {"languages": ["English"], "skills": ["Python"]}}
    tailored = {"summary": "s", "experiences": [], "skills": ["Python"], "education": [], "changes_applied": []}
    c.generate(cv, tailored, "cand-1", template="onyx")
    method, url, kwargs = fake.calls[2]  # PATCH /api/resume/res-1
    assert kwargs["json"]["data"]["metadata"]["template"] == "onyx"
