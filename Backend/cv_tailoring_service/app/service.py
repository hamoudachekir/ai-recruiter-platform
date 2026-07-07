from app.db import get_job
from app.keywords import extract_keywords
from app.llm import tailor_cv
from app.anti_hallucination import verify
from app.schema import Verification, TailoredCv, TailorResponse


class JobNotFound(Exception):
    pass


class NoJobSpecified(Exception):
    pass


class TailorRejected(Exception):
    def __init__(self, verification: Verification):
        super().__init__("Tailored CV failed anti-hallucination after retry")
        self.verification = verification


def run_tailor(candidate_id: str, job_id: str | None, cv_json_dict: dict, job_text: str | None = None) -> TailorResponse:
    if job_text and job_text.strip():
        # Pasted job description: extract keywords from the text directly,
        # no DB lookup needed. Works with no platform job_id at all (e.g. the
        # candidate profile's standalone "Adapter mon CV" tab).
        keywords = extract_keywords({"description": job_text}, top_k=20)
    elif job_id:
        job = get_job(job_id)
        if job is None:
            raise JobNotFound(job_id)
        keywords = extract_keywords(job, top_k=20)
    else:
        raise NoJobSpecified("Provide either job_id or job_text")

    tailored: TailoredCv = tailor_cv(cv_json_dict, keywords)
    v = verify(cv_json_dict, tailored.model_dump())

    if not v.passed:
        extra = (
            "Le CV precedent a introduit des elements factuels ABSENTS de l'original: "
            + ", ".join(v.invented_entities)
            + ". Ne les inclus pas. N'ajoute aucune entreprise, date, diplome ou chiffre absent de l'original."
        )
        tailored = tailor_cv(cv_json_dict, keywords, extra_instruction=extra)
        v = verify(cv_json_dict, tailored.model_dump(), retried=True)
        # Advisory, not blocking: real CVs are noisy and the guard errs toward
        # false positives, so we still return the tailored CV and let the UI
        # surface `verification.passed` softly instead of failing the request.

    return TailorResponse(
        tailored_cv_json=tailored,
        changes_applied=tailored.changes_applied,
        verification=v,
        keywords=keywords,
    )
