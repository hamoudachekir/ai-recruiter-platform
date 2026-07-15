import os
import re
import uuid
import httpx
from app.config import get_settings
from app.mapping import to_rxresume_data

_REQUIRED_KEYS = ("basics", "sections", "metadata")


class RxResumeError(RuntimeError):
    pass


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "candidate").lower()).strip("-")
    return f"{slug or 'candidate'}-{uuid.uuid4().hex[:8]}"


class RxResumeClient:
    """
    Client for a self-hosted Reactive Resume v4.4.6 instance.

    Confirmed against a live instance (no public docs matched this version):
    - No API-key concept. Auth is cookie/JWT via POST /api/auth/login, which
      sets httpOnly `Authentication`/`Refresh` cookies that must be replayed
      on subsequent requests.
    - POST /api/resume accepts only {title, slug} — any `data` in the body is
      ignored — and returns a fresh default `data` skeleton. So creating a
      resume doubles as fetching the base skeleton; no separate probe call
      (and no leftover throwaway resume) is needed.
    - PATCH /api/resume/{id} {data} applies our content.
    - GET /api/resume/print/{id} synchronously renders the PDF and returns
      {url} — a direct link into the storage backend (MinIO), not proxied
      through the app, so RXRESUME_URL alone is not enough: STORAGE_URL must
      also be a publicly reachable endpoint (see docker-compose.rxresume.yml).
    """

    def __init__(self, http=httpx):
        self._http = http
        self._cookies: dict = {}

    # ---- low-level ---------------------------------------------------------
    def _url(self, path: str) -> str:
        return f"{get_settings().rxresume_url}{path}"

    def _json_request(self, method, path, **kwargs):
        try:
            resp = self._http.request(
                method, self._url(path),
                headers={"Content-Type": "application/json"},
                cookies=self._cookies,
                timeout=60,
                **kwargs,
            )
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, ValueError) as e:
            # ValueError covers json.JSONDecodeError on a 2xx with a bad/empty body.
            raise RxResumeError(f"Reactive Resume {method} {path} failed: {e}") from e

    def assert_schema(self, data: dict):
        missing = [k for k in _REQUIRED_KEYS if k not in data]
        if missing:
            raise RxResumeError(f"Reactive Resume data schema mismatch — missing keys: {missing}")

    # ---- auth ---------------------------------------------------------------
    def login(self):
        s = get_settings()
        if not s.rxresume_email or not s.rxresume_password:
            raise RxResumeError(
                "RXRESUME_EMAIL / RXRESUME_PASSWORD are not configured for the cv-tailoring-service"
            )
        try:
            resp = self._http.request(
                "POST", self._url("/api/auth/login"),
                json={"identifier": s.rxresume_email, "password": s.rxresume_password},
                headers={"Content-Type": "application/json"},
                timeout=30,
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise RxResumeError(f"Reactive Resume login failed: {e}") from e
        self._cookies = dict(resp.cookies)
        if not self._cookies:
            raise RxResumeError("Reactive Resume login succeeded but returned no session cookie")

    # ---- high-level --------------------------------------------------------
    def create_resume(self, title: str) -> tuple[str, dict]:
        created = self._json_request("POST", "/api/resume", json={"title": title, "slug": _slugify(title)})
        rid = created.get("id")
        data = created.get("data")
        if not rid or not data:
            raise RxResumeError("create_resume: response missing id or data")
        self.assert_schema(data)
        return rid, data

    def update_resume(self, resume_id: str, data: dict):
        self._json_request("PATCH", f"/api/resume/{resume_id}", json={"data": data})

    def export_pdf(self, resume_id: str) -> str:
        out = self._json_request("GET", f"/api/resume/print/{resume_id}")
        url = out.get("url")
        if not url:
            raise RxResumeError("export_pdf: response missing pdf url")
        return url

    def download(self, url: str) -> bytes:
        try:
            resp = self._http.request("GET", url, timeout=120)
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPError as e:
            raise RxResumeError(f"Failed to download PDF: {e}") from e

    def save_pdf(self, content: bytes, candidate_id: str) -> str:
        out_dir = get_settings().tailored_cv_upload_dir
        if not os.path.isabs(out_dir):
            # Resolve relative to the service root (…/cv_tailoring_service), NOT
            # the process CWD. The returned URL is always /uploads/tailored-cvs/…,
            # which Express serves from Backend/server/uploads/tailored-cvs, so
            # the file must land there no matter where the service was launched.
            service_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            out_dir = os.path.abspath(os.path.join(service_root, out_dir))
        os.makedirs(out_dir, exist_ok=True)
        filename = f"tailored-{candidate_id}-{uuid.uuid4().hex[:8]}.pdf"
        with open(os.path.join(out_dir, filename), "wb") as f:
            f.write(content)
        return f"/uploads/tailored-cvs/{filename}"

    def generate(self, cv_json: dict, tailored: dict, candidate_id: str, template: str | None = None) -> tuple[str, str]:
        self.login()
        title = f"{cv_json.get('name', 'candidate')} — tailored"
        resume_id, base = self.create_resume(title)
        data = to_rxresume_data(cv_json, tailored, base, template=template)
        self.assert_schema(data)
        self.update_resume(resume_id, data)
        pdf_url = self.export_pdf(resume_id)
        content = self.download(pdf_url)
        pdf_path = self.save_pdf(content, candidate_id)
        return pdf_path, resume_id
