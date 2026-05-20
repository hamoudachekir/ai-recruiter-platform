"""Interview metadata resolution service.

Resolves real candidate and job information from MongoDB collections
given an interview/room ID. This ensures reports contain accurate
metadata rather than placeholder values.
"""

import logging
import os
from typing import Optional

from app.db.mongo import _client
from bson.errors import InvalidId
from bson.objectid import ObjectId

_LOGGER = logging.getLogger(__name__)

# Configuration for metadata database
# Post-consolidation, call rooms, users, jobs, and applications all live in
# the single "ai_recruiter" database alongside the analysis collections.
# USERS_DB_NAME is kept as an env-var override for backward compatibility.
USERS_DB_NAME = os.getenv("USERS_DB_NAME", os.getenv("MONGO_DB_NAME", "ai_recruiter"))


def _get_users_db():
    """Get the database where call rooms and related collections live.

    The database name can be configured via USERS_DB_NAME or MONGO_DB_NAME.
    Default is "ai_recruiter" (single consolidated database).
    """
    return _client[USERS_DB_NAME]


def _coerce_object_id(value: str | ObjectId | None) -> Optional[ObjectId]:
    """Safely convert a string to ObjectId."""
    if value is None:
        return None
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except InvalidId:
        return None


def resolve_interview_metadata(interview_id: str) -> dict:
    """Resolve real candidate and job metadata for an interview.

    Given an interview ID (which may be a room ID or MongoDB _id),
    looks up the call room and resolves:
    - Candidate name and email from the User collection
    - Job title from the Job collection
    - Application ID if available

    Args:
        interview_id: The interview/room ID to look up

    Returns:
        Dictionary with resolved metadata:
        {
            "candidate_name": str,      # Full name or email
            "candidate_email": str,     # Email address
            "job_title": str,           # Job title
            "job_id": str | None,       # Job ObjectId as string
            "application_id": str | None, # Application ID if found
            "found": bool,              # Whether any metadata was found
        }
    """
    result = {
        "candidate_name": None,
        "candidate_email": None,
        "job_title": None,
        "job_id": None,
        "application_id": None,
        "found": False,
    }

    if not interview_id:
        _LOGGER.warning("[metadata] No interview_id provided")
        return result

    # Get collections from the users database
    users_db = _get_users_db()
    db_name = USERS_DB_NAME
    call_rooms_col = users_db["callrooms"]
    users_col = users_db["users"]
    jobs_col = users_db["jobs"]
    applications_col = users_db["applications"]

    _LOGGER.debug(
        "[metadata] Looking up interview_id=%s in database=%s collection=callrooms",
        interview_id,
        db_name,
    )

    # Find call room by _id or roomId
    call_room = None
    room_oid = _coerce_object_id(interview_id)
    lookup_attempts = []

    if room_oid:
        lookup_attempts.append(("_id", room_oid))
        call_room = call_rooms_col.find_one({"_id": room_oid})

    if not call_room:
        lookup_attempts.append(("roomId", interview_id))
        call_room = call_rooms_col.find_one({"roomId": interview_id})

    if not call_room:
        # Try to find by interviewId field if it exists
        lookup_attempts.append(("interviewId", interview_id))
        call_room = call_rooms_col.find_one({"interviewId": interview_id})

    if not call_room:
        _LOGGER.warning(
            "[metadata] No call room found for interview_id=%s in database=%s. "
            "Lookup attempted: %s",
            interview_id,
            db_name,
            lookup_attempts,
        )
        return result

    result["found"] = True
    room_id_str = str(call_room.get("_id", "unknown"))
    room_room_id = call_room.get("roomId", "N/A")

    _LOGGER.info(
        "[metadata] Found call room for interview_id=%s: "
        "room_oid=%s, roomId=%s, database=%s",
        interview_id,
        room_id_str,
        room_room_id,
        db_name,
    )

    # Resolve candidate
    candidate_id = call_room.get("candidate")
    _LOGGER.debug(
        "[metadata] Resolving candidate from room: candidate_id=%s, database=%s",
        candidate_id,
        db_name,
    )

    if candidate_id:
        candidate_oid = _coerce_object_id(candidate_id)
        if candidate_oid:
            _LOGGER.debug(
                "[metadata] Looking up candidate in database=%s collection=users _id=%s",
                db_name,
                candidate_oid,
            )
            candidate = users_col.find_one({"_id": candidate_oid})
            if candidate:
                # Build candidate name from available fields
                first_name = candidate.get("firstName", "")
                last_name = candidate.get("lastName", "")
                email = candidate.get("email", "")

                if first_name and last_name:
                    result["candidate_name"] = f"{first_name} {last_name}".strip()
                elif first_name:
                    result["candidate_name"] = first_name
                elif email:
                    result["candidate_name"] = email
                else:
                    result["candidate_name"] = "Unknown Candidate"

                result["candidate_email"] = email or ""

                _LOGGER.debug(
                    "[metadata] Resolved candidate: %s (%s)",
                    result["candidate_name"],
                    result["candidate_email"],
                )
            else:
                _LOGGER.warning(
                    "[metadata] Candidate not found in users collection: %s",
                    str(candidate_oid),
                )
        else:
            _LOGGER.warning(
                "[metadata] Invalid candidate ID format: %s", str(candidate_id)
            )
    else:
        _LOGGER.debug("[metadata] No candidate assigned to room")

    # Resolve job
    job_id = call_room.get("job")
    _LOGGER.debug(
        "[metadata] Resolving job from room: job_id=%s, database=%s", job_id, db_name
    )

    if job_id:
        job_oid = _coerce_object_id(job_id)
        if job_oid:
            _LOGGER.debug(
                "[metadata] Looking up job in database=%s collection=jobs _id=%s",
                db_name,
                job_oid,
            )
            job = jobs_col.find_one({"_id": job_oid})
            if job:
                result["job_title"] = job.get("title", "Unknown Role")
                result["job_id"] = str(job_oid)

                _LOGGER.debug(
                    "[metadata] Resolved job: %s (%s)",
                    result["job_title"],
                    result["job_id"],
                )
            else:
                _LOGGER.warning(
                    "[metadata] Job not found in jobs collection: %s", str(job_oid)
                )
        else:
            _LOGGER.warning("[metadata] Invalid job ID format: %s", str(job_id))
    else:
        _LOGGER.debug("[metadata] No job assigned to room")

    # Try to find application
    if candidate_id and job_id:
        _LOGGER.debug(
            "[metadata] Looking up application: candidate=%s, job=%s, database=%s",
            candidate_id,
            job_id,
            db_name,
        )
        candidate_oid = _coerce_object_id(candidate_id)
        job_oid = _coerce_object_id(job_id)

        if candidate_oid and job_oid:
            application = applications_col.find_one(
                {
                    "candidate": candidate_oid,
                    "job": job_oid,
                }
            )
            if application:
                result["application_id"] = str(application.get("_id"))
                _LOGGER.debug(
                    "[metadata] Found application: %s", result["application_id"]
                )

    # Log detailed summary
    if result["candidate_name"] and result["job_title"]:
        _LOGGER.info(
            "[metadata] Successfully resolved metadata for interview=%s: "
            "candidate=%s (%s), job=%s (%s), application=%s, database=%s",
            interview_id,
            result["candidate_name"],
            result["candidate_email"],
            result["job_title"],
            result["job_id"],
            result["application_id"] or "none",
            db_name,
        )
    elif result["found"]:
        _LOGGER.warning(
            "[metadata] Partial metadata resolution for interview=%s: "
            "candidate=%s, job=%s, database=%s",
            interview_id,
            result["candidate_name"] or "MISSING",
            result["job_title"] or "MISSING",
            db_name,
        )
    else:
        _LOGGER.warning(
            "[metadata] Failed to resolve metadata for interview=%s: "
            "room not found in database=%s",
            interview_id,
            db_name,
        )

    return result


def _extract_responsibilities(description: str) -> list:
    """Extract responsibility bullet points from a job description."""
    if not description:
        return []
    import re

    lines = description.split("\n")
    responsibilities = []
    in_section = False
    section_headers = [
        "responsibilit",
        "duties",
        "tasks",
        "you will",
        "what you'll do",
        "role includes",
    ]
    end_headers = [
        "qualif",
        "requirement",
        "must have",
        "skill",
        "what we offer",
        "benefit",
        "education",
    ]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        line_lower = line.lower()
        if any(kw in line_lower for kw in section_headers):
            in_section = True
            continue
        if in_section and any(kw in line_lower for kw in end_headers):
            in_section = False
        if in_section:
            clean = re.sub(r"^[-•*·\d\.\)]+\s*", "", line).strip()
            if clean and len(clean.split()) >= 3:
                responsibilities.append(clean)
    return responsibilities[:8]


def _extract_qualifications(description: str) -> list:
    """Extract required qualifications from a job description."""
    if not description:
        return []
    import re

    lines = description.split("\n")
    qualifications = []
    in_section = False
    section_headers = [
        "qualif",
        "requirement",
        "required",
        "must have",
        "skills required",
    ]
    end_headers = ["preferred", "nice to have", "bonus", "what we offer", "benefit"]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        line_lower = line.lower()
        if any(kw in line_lower for kw in section_headers):
            in_section = True
            continue
        if in_section and any(kw in line_lower for kw in end_headers):
            in_section = False
        if in_section:
            clean = re.sub(r"^[-•*·\d\.\)]+\s*", "", line).strip()
            if clean and len(clean.split()) >= 2:
                qualifications.append(clean)
    return qualifications[:8]


def resolve_full_job_context(interview_id: str) -> dict:
    """Resolve full job context including skills, responsibilities, requirements.

    Args:
        interview_id: Room ID or MongoDB _id

    Returns:
        jobContext dict with linked, jobId, title, companyName, location,
        requiredSkills, requiredLanguages, responsibilities, requiredQualifications.
    """
    not_linked: dict = {
        "linked": False,
        "jobId": None,
        "title": "Job not linked",
        "companyName": "",
        "location": "",
        "salary": None,
        "description": None,
        "requiredSkills": [],
        "requiredLanguages": [],
        "responsibilities": [],
        "requiredQualifications": [],
    }

    if not interview_id:
        return not_linked

    users_db = _get_users_db()
    cr_col = users_db["callrooms"]
    jobs_col_u = users_db["jobs"]
    users_col = users_db["users"]

    # Find call room
    room = None
    oid = _coerce_object_id(interview_id)
    if oid:
        room = cr_col.find_one({"_id": oid})
    if not room:
        room = cr_col.find_one({"roomId": interview_id})
    if not room:
        return not_linked

    job_id = room.get("job")
    if not job_id:
        return not_linked

    job_oid = _coerce_object_id(job_id)
    if not job_oid:
        return not_linked

    job = jobs_col_u.find_one({"_id": job_oid})
    if not job:
        _LOGGER.warning("[job_context] Job not found: %s", str(job_oid))
        return not_linked

    # Resolve company name from entrepriseId
    company_name = ""
    entreprise_id = job.get("entrepriseId")
    if entreprise_id:
        ent_oid = _coerce_object_id(entreprise_id)
        if ent_oid:
            ent = users_col.find_one({"_id": ent_oid})
            if ent:
                company_name = (
                    ent.get("companyName")
                    or ent.get("company")
                    or f"{ent.get('firstName', '')} {ent.get('lastName', '')}".strip()
                    or ""
                )

    description = job.get("description") or ""
    responsibilities = _extract_responsibilities(description)
    qualifications = _extract_qualifications(description)

    raw_skills = job.get("skills") or []
    skills = (
        [str(s).strip() for s in raw_skills if s]
        if isinstance(raw_skills, list)
        else []
    )

    raw_langs = job.get("languages") or []
    languages = (
        [str(l).strip() for l in raw_langs if l] if isinstance(raw_langs, list) else []
    )

    salary_val = job.get("salary")
    salary = f"{salary_val} €" if salary_val else None

    _LOGGER.info(
        "[job_context] Resolved: title=%s skills=%d langs=%d",
        job.get("title"),
        len(skills),
        len(languages),
    )

    return {
        "linked": True,
        "jobId": str(job_oid),
        "title": job.get("title") or "Unknown Role",
        "companyName": company_name,
        "location": job.get("location") or "",
        "salary": salary,
        "description": description[:500] if description else None,
        "requiredSkills": skills,
        "requiredLanguages": languages,
        "responsibilities": responsibilities,
        "requiredQualifications": qualifications,
    }


def get_report_metadata(interview_id: str) -> dict:
    """Get metadata formatted for report generation.

    Returns metadata in the format expected by build_final_report.
    Uses safe fallbacks if data cannot be resolved.

    Args:
        interview_id: The interview/room ID

    Returns:
        Dictionary with:
        {
            "candidate_name": str,   # Safe fallback if not found
            "candidate_email": str,
            "job_title": str,        # "Job not linked" if not found
            "job_id": str | None,
            "application_id": str | None,
            "job_metadata_status": "linked" | "missing",
        }
    """
    resolved = resolve_interview_metadata(interview_id)

    job_title = resolved["job_title"]
    job_id = resolved["job_id"]

    # Explicitly indicate when job is not linked
    if not job_title and not job_id:
        job_title = "Job not linked"
        job_metadata_status = "missing"
    else:
        job_metadata_status = "linked"

    return {
        "candidate_name": resolved["candidate_name"] or "Candidate",
        "candidate_email": resolved["candidate_email"] or "",
        "job_title": job_title,
        "job_id": job_id,
        "application_id": resolved["application_id"],
        "job_metadata_status": job_metadata_status,
    }
