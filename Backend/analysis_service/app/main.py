from pathlib import Path

# Load root .env before any other imports so all os.getenv() calls see it.
# main.py lives at Backend/analysis_service/app/main.py → repo root is 3 parents up.
try:
    from dotenv import load_dotenv

    _root_env = Path(__file__).resolve().parents[3] / ".env"
    if _root_env.exists():
        load_dotenv(_root_env, override=False)  # override=False: existing env vars win
except ImportError:
    pass  # python-dotenv not installed — rely on process environment

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import PlainTextResponse, Response

from app.api.routes_admin import router as admin_router
from app.api.routes_analysis import router as analysis_router
from app.api.routes_ats import router as ats_router
from app.api.routes_behavioral_insights import router as behavioral_insights_router
from app.api.routes_behavioral_timeline import router as behavioral_timeline_router
from app.api.routes_copilot import router as copilot_router
from app.api.routes_feedback import router as feedback_router
from app.api.routes_ranking import router as ranking_router
from app.api.routes_realtime import router as realtime_router
from app.api.routes_tenants import router as tenants_router
from app.middleware.tenant_context import TenantContextMiddleware

app = FastAPI(title="Next Hire Post-Interview Analysis Service", version="5.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TenantContextMiddleware)

app.include_router(analysis_router)
app.include_router(behavioral_insights_router)
app.include_router(behavioral_timeline_router)
app.include_router(feedback_router)
app.include_router(admin_router)
app.include_router(tenants_router)
app.include_router(copilot_router)
app.include_router(ranking_router)
app.include_router(realtime_router)
app.include_router(ats_router)


@app.get("/health")
def health():
    return {"ok": True, "phase": "5", "service": "analysis"}


@app.get("/metrics")
def metrics():
    try:
        prometheus_client = __import__("prometheus_client")
        content_type = getattr(prometheus_client, "CONTENT_TYPE_LATEST")
        generate_latest = getattr(prometheus_client, "generate_latest")
        return Response(generate_latest(), media_type=content_type)
    except ImportError:
        return PlainTextResponse(
            "prometheus-client is not installed; run `pip install -r requirements.txt`.\n",
            status_code=503,
        )
