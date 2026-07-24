from fastapi import FastAPI, HTTPException

from app.applications import list_applications, save_analysis, update_application
from app.cover_letter import generate_cover_letter
from app.fit import analyze_fit
from app.llm import LlmError, LlmRateLimited
from app.rxresume_client import RxResumeClient, RxResumeError
from app.schema import (
    AnalyzeRequest,
    AnalyzeResponse,
    ApplicationRecord,
    ApplicationUpdate,
    CoverLetterRequest,
    CoverLetterResponse,
    ExportRequest,
    ExportResponse,
    TailorRequest,
    TailorResponse,
)
from app.service import JobNotFound, NoJobSpecified, TailorRejected, run_tailor

app = FastAPI(title="cv-tailoring-service")


@app.get("/health")
def health():
    return {"status": "ok", "service": "cv-tailoring-service"}


@app.post("/tailor", response_model=TailorResponse)
def tailor(req: TailorRequest):
    try:
        return run_tailor(req.candidate_id, req.job_id, req.cv_json.model_dump(), job_text=req.job_text)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="Job not found")
    except NoJobSpecified:
        raise HTTPException(status_code=400, detail="Aucune offre spécifiée. Renseignez une description de poste.")
    except TailorRejected as e:
        raise HTTPException(status_code=422, detail={
            "message": "Tailored CV introduced facts absent from the original.",
            "invented_entities": e.verification.invented_entities,
        })
    except LlmRateLimited as e:
        raise HTTPException(status_code=429, detail={"message": str(e)})
    except LlmError as e:
        raise HTTPException(status_code=502, detail=f"LLM reformulation failed: {e}")


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest):
    analysis = analyze_fit(req.cv_json.model_dump(), req.job_text)
    application = save_analysis(
        candidate_id=req.candidate_id,
        job_text=req.job_text,
        analysis=analysis,
        job_title=req.job_title,
        company=req.company,
        source_url=req.source_url,
    )
    return AnalyzeResponse(analysis=analysis, application_id=application.id)


@app.post("/cover-letter", response_model=CoverLetterResponse)
def cover_letter(req: CoverLetterRequest):
    return CoverLetterResponse(
        content=generate_cover_letter(
            cv_json=req.cv_json.model_dump(),
            job_text=req.job_text,
            job_title=req.job_title,
            company=req.company,
            language=req.language,
        ),
        language=req.language,
    )


@app.get("/applications/{candidate_id}", response_model=list[ApplicationRecord])
def applications(candidate_id: str):
    return list_applications(candidate_id)


@app.patch("/applications/{candidate_id}/{application_id}", response_model=ApplicationRecord)
def application_update(candidate_id: str, application_id: int, req: ApplicationUpdate):
    application = update_application(application_id, candidate_id, req)
    if application is None:
        raise HTTPException(status_code=404, detail="Application not found")
    return application


@app.post("/export-pdf", response_model=ExportResponse)
def export_pdf(req: ExportRequest):
    try:
        pdf_path, resume_id = RxResumeClient().generate(
            req.cv_json.model_dump(), req.tailored_cv_json.model_dump(), req.candidate_id or "candidate",
            template=req.template,
        )
        return ExportResponse(pdf_path=pdf_path, resume_id=resume_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RxResumeError as e:
        raise HTTPException(status_code=502, detail=f"Reactive Resume unavailable: {e}")
