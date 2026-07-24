from datetime import datetime
from typing import List, Literal, Optional
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


class FitAnalysis(BaseModel):
    score: int = Field(ge=0, le=100)
    recommendation: Literal["apply", "consider", "skip"]
    matched_skills: List[str] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    matched_keywords: List[str] = Field(default_factory=list)
    missing_keywords: List[str] = Field(default_factory=list)
    evidence: List[str] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    candidate_id: str
    cv_json: CvJson
    job_text: str = Field(min_length=20)
    job_title: str = ""
    company: str = ""
    source_url: str = ""


class AnalyzeResponse(BaseModel):
    analysis: FitAnalysis
    application_id: int


class CoverLetterRequest(BaseModel):
    cv_json: CvJson
    job_text: str = Field(min_length=20)
    job_title: str = ""
    company: str = ""
    language: Literal["fr", "en"] = "fr"


class CoverLetterResponse(BaseModel):
    content: str
    language: Literal["fr", "en"]


class ApplicationRecord(BaseModel):
    id: int
    candidate_id: str
    job_title: str
    company: str
    source_url: str
    job_text: str
    score: int
    recommendation: Literal["apply", "consider", "skip"]
    status: Literal["discovered", "preparing", "applied", "interview", "offer", "rejected"]
    notes: str = ""
    created_at: datetime
    updated_at: datetime


class ApplicationUpdate(BaseModel):
    status: Optional[Literal["discovered", "preparing", "applied", "interview", "offer", "rejected"]] = None
    notes: Optional[str] = None


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
