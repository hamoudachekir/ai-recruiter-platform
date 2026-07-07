from fastapi import FastAPI, HTTPException
from app.schema import TailorRequest, TailorResponse, ExportRequest, ExportResponse
from app.service import run_tailor, JobNotFound, NoJobSpecified, TailorRejected
from app.llm import LlmError, LlmRateLimited
from app.rxresume_client import RxResumeClient, RxResumeError

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
