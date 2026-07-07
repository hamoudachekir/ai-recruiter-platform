from typing import List, Optional
from pydantic import BaseModel, Field


class Experience(BaseModel):
    title: str = ""
    company: str = ""
    duration: str = ""
    description: str = ""


class CvProfile(BaseModel):
    resume: str = ""
    shortDescription: str = ""
    skills: List[str] = Field(default_factory=list)
    phone: str = ""
    languages: List[str] = Field(default_factory=list)
    availability: str = "Full-time"
    domain: str = ""
    experience: List[Experience] = Field(default_factory=list)


class CvJson(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    role: str = "CANDIDATE"
    domain: str = ""
    profile: CvProfile = Field(default_factory=CvProfile)
    education: List[str] = Field(default_factory=list)


class TailoredCv(BaseModel):
    summary: str = ""
    experiences: List[Experience] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    education: List[str] = Field(default_factory=list)
    changes_applied: List[str] = Field(default_factory=list)


class Verification(BaseModel):
    passed: bool
    invented_entities: List[str] = Field(default_factory=list)
    retried: bool = False


class TailorRequest(BaseModel):
    candidate_id: str
    # Optional: tailoring can run purely from a pasted job description (no
    # platform job in context — e.g. from the candidate's profile page).
    job_id: Optional[str] = None
    cv_json: CvJson
    # Pasted job description (JobSuite-style). When provided, keywords are
    # extracted from this text and the DB job lookup is skipped.
    job_text: Optional[str] = None


class TailorResponse(BaseModel):
    tailored_cv_json: TailoredCv
    changes_applied: List[str]
    verification: Verification
    # JD keywords used for tailoring — lets the client compute a live
    # keyword-match score against the (merged) CV.
    keywords: List[str] = Field(default_factory=list)


class ExportRequest(BaseModel):
    candidate_id: Optional[str] = None
    job_id: Optional[str] = None
    cv_json: CvJson
    tailored_cv_json: TailoredCv
    # One of the 12 built-in Reactive Resume templates (see app.mapping.
    # RXRESUME_TEMPLATES). Defaults to the instance's own default when omitted.
    template: Optional[str] = None


class ExportResponse(BaseModel):
    pdf_path: str
    resume_id: str
