import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Tuple
from uuid import uuid4

import httpx

from app.config import Settings
from app.repositories.interview_schedule_repository import InterviewScheduleRepository
from app.repositories.schedule_log_repository import ScheduleLogRepository
from app.services.email_service import EmailService, EmailServiceError
from app.services.google_calendar_service import (
    GoogleCalendarService,
    GoogleCalendarServiceError,
)
from app.services.recommendation_service import RecommendationService
from app.services.side_effect_retry_service import SideEffectRetryService

logger = logging.getLogger(__name__)
RECRUITER_TOKEN_NOT_AVAILABLE = "Recruiter Google token not available"


class SchedulingConflictError(ValueError):
    """Raised when selected slot conflicts and alternatives are available."""

    def __init__(self, message: str, suggested_slots: Optional[List[Dict[str, Any]]] = None):
        super().__init__(message)
        self.suggested_slots = suggested_slots or []


class SchedulingOrchestrator:
    """
    Main orchestrator for interview scheduling workflow.
    Coordinates repositories, services, and external integrations.
    """
    
    def __init__(
        self,
        schedule_repo: InterviewScheduleRepository,
        log_repo: ScheduleLogRepository,
        recommendation_service: RecommendationService,
        google_calendar_service: GoogleCalendarService,
        email_service: EmailService,
        retry_service: SideEffectRetryService,
        settings: Settings
    ):
        """
        Initialize orchestrator with dependencies.
        
        Args:
            schedule_repo: Interview schedule repository
            log_repo: Schedule log repository
            recommendation_service: Recommendation engine
            settings: Application settings/config
        """
        self.schedule_repo = schedule_repo
        self.log_repo = log_repo
        self.recommendation_service = recommendation_service
        self.google_calendar_service = google_calendar_service
        self.email_service = email_service
        self.retry_service = retry_service
        self.settings = settings
        # In-process lock per recruiter to avoid concurrent double-booking.
        self._recruiter_locks: Dict[str, asyncio.Lock] = {}
        # Reserve top suggested slots briefly so concurrent starts don't surface the same top choice.
        self._tentative_slot_hold_minutes = 120
        self._tentative_slots_per_schedule = 1
    
    async def start_interview_scheduling(
        self,
        candidate_id: str,
        recruiter_id: str,
        job_id: str,
        application_id: str,
        interview_type: str,
        interview_mode: str,
        duration_minutes: Optional[int] = None,
        optimization_options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Start the interview scheduling workflow.
        
        Workflow:
        1. Create draft interview schedule
        2. Fetch candidate/recruiter/job metadata from Node backend
        3. Fetch recruiter Google Calendar busy slots (if available)
        4. Generate deterministic recommended slots
        5. Save and log suggested slots
        
        Args:
            candidate_id: Candidate ID
            recruiter_id: Recruiter ID
            job_id: Job ID
            application_id: Application ID
            interview_type: Type of interview (phone, video, etc.)
            interview_mode: Mode (synchronous, asynchronous)
            duration_minutes: Duration in minutes
            
        Returns:
            Dict with suggested slots and schedule info
            
        Raises:
            Exception: If workflow step fails
        """
        logger.info(
            f"Starting interview scheduling for candidate {candidate_id}, "
            f"recruiter {recruiter_id}, job {job_id}"
        )
        
        try:
            options = optimization_options if isinstance(optimization_options, dict) else {}
            interview_stage = str(options.get("interview_stage") or "technical").lower()
            buffer_minutes = options.get("buffer_minutes")
            job_priority = str(options.get("job_priority") or "normal").lower()
            candidate_level = str(options.get("candidate_level") or "intermediate").lower()
            recruiter_preferences = options.get("recruiter_preferences") or {}
            candidate_timezone = options.get("candidate_timezone")
            recruiter_timezone = options.get("recruiter_timezone")
            top_n = options.get("top_n", 5)

            resolved_duration, resolved_buffer = self._resolve_duration_and_buffer(
                interview_stage=interview_stage,
                duration_minutes=duration_minutes,
                buffer_minutes=buffer_minutes,
            )
            normalized_top_n = max(3, min(int(top_n or 5), 10))
            optimization_context = self._build_optimization_context(
                interview_stage=interview_stage,
                job_priority=job_priority,
                candidate_level=candidate_level,
                recruiter_preferences=recruiter_preferences or {},
                candidate_timezone=candidate_timezone,
                recruiter_timezone=recruiter_timezone,
            )

            candidate_action_token = uuid4().hex
            candidate_action_expires_at = self._utcnow_naive() + timedelta(
                days=max(7, int(self.settings.scheduling_days_ahead or 7))
            )
            candidate_action_link = self._build_candidate_action_link(candidate_action_token)

            schedule_data = {
                "candidate_id": candidate_id,
                "recruiter_id": recruiter_id,
                "job_id": job_id,
                "application_id": application_id,
                "interview_type": interview_type,
                "interview_mode": interview_mode,
                "interview_stage": interview_stage,
                "duration_minutes": resolved_duration,
                "buffer_minutes": resolved_buffer,
                "job_priority": job_priority,
                "candidate_level": candidate_level,
                "recruiter_preferences": recruiter_preferences or {},
                "candidate_timezone": candidate_timezone or self.settings.timezone_default,
                "recruiter_timezone": recruiter_timezone or self.settings.timezone_default,
                "optimization_context": optimization_context,
                "status": "draft",
                "email_status": "pending",
                "suggested_slots": [],
                "confirmed_slot": None,
                "calendar_event_id": None,
                "meeting_link": None,
                "location": None,
                "candidate_action_token": candidate_action_token,
                "candidate_action_expires_at": candidate_action_expires_at,
                "candidate_action_link": candidate_action_link,
                "notes": "",
            }
            
            schedule_id = await self.schedule_repo.create(schedule_data)
            logger.info(f"Created draft schedule: {schedule_id}")
            
            await self.log_repo.log_action(
                schedule_id,
                "scheduling_started",
                {
                    "candidate_id": candidate_id,
                    "recruiter_id": recruiter_id,
                    "job_id": job_id
                }
            )
            
            candidate_info, recruiter_info, job_info = await self._fetch_external_data(
                candidate_id,
                recruiter_id,
                job_id
            )

            recruiter_lock = self._get_recruiter_lock(recruiter_id)
            async with recruiter_lock:
                busy_slots = await self._get_recruiter_availability(
                    recruiter_id,
                    exclude_schedule_id=schedule_id,
                    include_tentative_suggestions=True,
                )
                logger.debug(f"Found {len(busy_slots)} busy slots for recruiter")

                suggested_slots = self.recommendation_service.generate_candidate_slots(
                    recruiter_busy_slots=busy_slots,
                    interview_duration=resolved_duration,
                    start_date=self._utcnow_naive(),
                    top_n=normalized_top_n,
                    optimization_context=optimization_context,
                )

                strategy_views = self.recommendation_service.build_strategy_views(
                    scored_slots=suggested_slots,
                    top_n=min(3, normalized_top_n),
                )
                suggested_slots_data = self._serialize_slots(suggested_slots)
                strategy_views_data = {
                    key: self._serialize_slots(value)
                    for key, value in strategy_views.items()
                }

                await self.schedule_repo.update(schedule_id, {
                    "status": "suggested_slots_ready",
                    "suggested_slots": suggested_slots_data,
                    "alternative_strategies": strategy_views_data,
                })

                await self.log_repo.log_action(
                    schedule_id,
                    "slots_generated",
                    {
                        "count": len(suggested_slots_data),
                        "top_3": [
                            {
                                "start": slot["start_time"],
                                "score": slot["score"]
                            }
                            for slot in suggested_slots_data[:3]
                        ],
                        "interview_stage": interview_stage,
                        "job_priority": job_priority,
                    }
                )
            
            logger.info(f"Generated {len(suggested_slots_data)} suggested slots for schedule {schedule_id}")
            
            return {
                "interview_schedule_id": schedule_id,
                "status": "suggested_slots_ready",
                "suggested_slots": suggested_slots_data,
                "candidate_info": candidate_info,
                "recruiter_info": recruiter_info,
                "job_info": job_info,
                "candidate_action_link": candidate_action_link,
                "alternative_strategies": strategy_views_data,
                "optimization_context": optimization_context,
                "message": f"Found {len(suggested_slots_data)} recommended interview slots"
            }
        
        except Exception as e:
            logger.error(f"Failed to start interview scheduling: {str(e)}", exc_info=True)
            raise
    
    async def confirm_slot(
        self,
        interview_schedule_id: str,
        selected_slot: Dict[str, str],
        location: Optional[str] = None,
        notes: str = ""
    ) -> Dict[str, Any]:
        """
        Confirm a selected interview slot and run Phase 2 side effects.
        
        Args:
            interview_schedule_id: Schedule ID
            selected_slot: Slot info with start_time, end_time
            location: Optional location/room
            notes: Optional notes
            
        Returns:
            Dict with confirmation details
            
        Raises:
            ValueError: If validation fails
            Exception: If workflow step fails
        """
        logger.info(f"Confirming slot for schedule {interview_schedule_id}")
        
        try:
            schedule = await self.schedule_repo.get_by_id(interview_schedule_id)
            if not schedule:
                raise ValueError(f"Schedule not found: {interview_schedule_id}")
            
            if schedule.get("status") not in ["suggested_slots_ready", "rescheduled"]:
                raise ValueError(
                    f"Cannot confirm slot for schedule in status: {schedule.get('status')}"
                )
            
            slot_start_iso = selected_slot.get("start_time")
            slot_end_iso = selected_slot.get("end_time")
            
            if not slot_start_iso or not slot_end_iso:
                raise ValueError("selected_slot must include start_time and end_time in ISO format")

            slot_start_dt = self._to_naive_utc(self._parse_iso_datetime(slot_start_iso))
            slot_end_dt = self._to_naive_utc(self._parse_iso_datetime(slot_end_iso))
            recruiter_id = str(schedule.get("recruiter_id") or "")
            if not recruiter_id:
                raise ValueError("Schedule recruiter_id is missing")

            recruiter_lock = self._get_recruiter_lock(recruiter_id)
            async with recruiter_lock:
                # Re-read inside lock to ensure we validate latest state.
                schedule = await self.schedule_repo.get_by_id(interview_schedule_id)
                if not schedule:
                    raise ValueError(f"Schedule not found: {interview_schedule_id}")

                if schedule.get("status") not in ["suggested_slots_ready", "rescheduled"]:
                    raise ValueError(
                        f"Cannot confirm slot for schedule in status: {schedule.get('status')}"
                    )

                has_conflict = await self.schedule_repo.has_recruiter_conflict(
                    recruiter_id=recruiter_id,
                    start_time_iso=slot_start_iso,
                    end_time_iso=slot_end_iso,
                    exclude_schedule_id=interview_schedule_id,
                )
                if has_conflict:
                    alternatives = await self._build_alternative_slots_for_schedule(
                        schedule=schedule,
                        top_n=3,
                        exclude_start_iso=slot_start_iso,
                    )
                    raise SchedulingConflictError(
                        "Selected slot conflicts with an existing recruiter meeting. Please choose another slot.",
                        suggested_slots=alternatives,
                    )

                candidate_info, recruiter_info, job_info = await self._fetch_external_data(
                    schedule["candidate_id"],
                    recruiter_id,
                    schedule["job_id"]
                )

                calendar_event_id = None
                meeting_link = None
                calendar_retry_payload = {
                    "start_time": slot_start_iso,
                    "end_time": slot_end_iso,
                    "location": location or "",
                    "notes": notes or "",
                    "interview_type": schedule.get("interview_type", "video"),
                }

                if schedule.get("interview_mode") == "synchronous":
                    recruiter_token = await self._get_recruiter_calendar_access_token(
                        recruiter_id
                    )

                    if recruiter_token:
                        try:
                            calendar_result = await asyncio.to_thread(
                                self.google_calendar_service.create_event,
                                access_token=recruiter_token,
                                summary=f"Interview - {job_info.get('title', 'Position')}",
                                description=self._build_calendar_description(
                                    candidate_info,
                                    recruiter_info,
                                    notes,
                                ),
                                start_time=slot_start_dt,
                                end_time=slot_end_dt,
                                attendee_emails=[
                                    candidate_info.get("email", ""),
                                    recruiter_info.get("email", ""),
                                ],
                                location=location,
                                create_meet_link=schedule.get("interview_type") in [
                                    "video",
                                    "assessment",
                                ],
                                calendar_id=self.settings.google_calendar_id,
                            )
                            calendar_event_id = calendar_result.get("id")
                            meeting_link = calendar_result.get("meeting_link")
                        except GoogleCalendarServiceError as exc:
                            await self.log_repo.log_action(
                                interview_schedule_id,
                                "calendar_error",
                                {
                                    "phase": "confirm",
                                    "error": str(exc),
                                },
                            )
                            await self._queue_side_effect_retry(
                                job_type="calendar_confirm",
                                interview_schedule_id=interview_schedule_id,
                                payload=calendar_retry_payload,
                                error_message=str(exc),
                            )
                    else:
                        token_error = RECRUITER_TOKEN_NOT_AVAILABLE
                        await self.log_repo.log_action(
                            interview_schedule_id,
                            "calendar_error",
                            {
                                "phase": "confirm",
                                "error": token_error,
                            },
                        )
                        await self._queue_side_effect_retry(
                            job_type="calendar_confirm",
                            interview_schedule_id=interview_schedule_id,
                            payload=calendar_retry_payload,
                            error_message=token_error,
                        )

                email_status = "pending"
                email_result: Dict[str, Any] = {}
                candidate_action_link = str(schedule.get("candidate_action_link") or "")
                email_retry_payload = {
                    "start_time": slot_start_iso,
                    "duration_minutes": schedule.get("duration_minutes", 60),
                    "location": location or "",
                    "notes": notes or "",
                    "meeting_link": meeting_link or "",
                    "candidate_action_link": candidate_action_link,
                    "interview_type": schedule.get("interview_type", "video"),
                    "interview_mode": schedule.get("interview_mode", "synchronous"),
                }
                try:
                    email_result = await self.email_service.send_invitation_notifications(
                        candidate=candidate_info,
                        recruiter=recruiter_info,
                        job_info=job_info,
                        interview_type=schedule.get("interview_type", "video"),
                        interview_mode=schedule.get("interview_mode", "synchronous"),
                        start_time=slot_start_dt,
                        duration_minutes=schedule.get("duration_minutes", 60),
                        location=location,
                        meeting_link=meeting_link,
                        notes=notes,
                        candidate_action_link=candidate_action_link,
                        candidate_timezone=schedule.get("candidate_timezone"),
                        recruiter_timezone=schedule.get("recruiter_timezone"),
                    )
                    email_status = "sent" if email_result.get("success") else "failed"
                except EmailServiceError as exc:
                    email_status = "failed"
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "email_failed",
                        {
                            "phase": "confirm",
                            "error": str(exc),
                        },
                    )
                    await self._queue_side_effect_retry(
                        job_type="email_confirm",
                        interview_schedule_id=interview_schedule_id,
                        payload=email_retry_payload,
                        error_message=str(exc),
                    )

                update_data = {
                    "status": "confirmed",
                    "confirmed_slot": {
                        "start_time": slot_start_iso,
                        "end_time": slot_end_iso,
                    },
                    "calendar_event_id": calendar_event_id,
                    "meeting_link": meeting_link,
                    "email_status": email_status,
                    "location": location or "",
                }
                if notes:
                    update_data["notes"] = notes

                success = await self.schedule_repo.update(interview_schedule_id, update_data)
                if not success:
                    raise RuntimeError(f"Failed to update schedule {interview_schedule_id}")

                await self.log_repo.log_action(
                    interview_schedule_id,
                    "slot_confirmed",
                    {
                        "slot_start": slot_start_iso,
                        "slot_end": slot_end_iso,
                        "location": location,
                        "calendar_event_id": calendar_event_id,
                    },
                )

                if calendar_event_id:
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "calendar_event_created",
                        {"calendar_event_id": calendar_event_id},
                    )

                if email_status == "sent":
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "invitation_sent",
                        {
                            "provider": email_result.get("candidate", {}).get("provider"),
                            "candidate": email_result.get("candidate", {}).get("sent_to", []),
                            "recruiter": email_result.get("recruiter", {}).get("sent_to", []),
                        },
                    )
                else:
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "email_failed",
                        {
                            "phase": "confirm",
                            "details": email_result,
                        },
                    )
                    await self._queue_side_effect_retry(
                        job_type="email_confirm",
                        interview_schedule_id=interview_schedule_id,
                        payload=email_retry_payload,
                        error_message="Invitation email delivery reported failure",
                    )

                await self._queue_default_reminders(
                    interview_schedule_id=interview_schedule_id,
                    slot_start_iso=slot_start_iso,
                )

                logger.info(f"Confirmed interview schedule {interview_schedule_id}")
            
            return {
                "interview_schedule_id": interview_schedule_id,
                "status": "confirmed",
                "calendar_event_id": calendar_event_id,
                "meeting_link": meeting_link,
                "candidate_action_link": candidate_action_link,
                "message": "Interview slot confirmed successfully"
            }
        
        except Exception as e:
            logger.error(f"Failed to confirm slot: {str(e)}", exc_info=True)
            
            # Log failure
            await self.log_repo.log_action(
                interview_schedule_id,
                "slot_confirmation_failed",
                {"error": str(e)}
            )
            
            raise
    
    async def reschedule_interview(
        self,
        interview_schedule_id: str,
        new_slot: Dict[str, str],
        notes: str = ""
    ) -> Dict[str, Any]:
        """
        Reschedule an interview and sync calendar + email side effects.
        """
        logger.info(f"Rescheduling interview {interview_schedule_id}")
        
        try:
            schedule = await self.schedule_repo.get_by_id(interview_schedule_id)
            if not schedule:
                raise ValueError(f"Schedule not found: {interview_schedule_id}")

            if schedule.get("status") not in ["confirmed", "rescheduled"]:
                raise ValueError(
                    f"Cannot reschedule interview in status: {schedule.get('status')}"
                )

            new_start_iso = new_slot.get("start_time")
            new_end_iso = new_slot.get("end_time")
            if not new_start_iso or not new_end_iso:
                raise ValueError("new_slot must include start_time and end_time")

            new_start_dt = self._to_naive_utc(self._parse_iso_datetime(new_start_iso))
            new_end_dt = self._to_naive_utc(self._parse_iso_datetime(new_end_iso))
            recruiter_id = str(schedule.get("recruiter_id") or "")
            if not recruiter_id:
                raise ValueError("Schedule recruiter_id is missing")

            recruiter_lock = self._get_recruiter_lock(recruiter_id)
            async with recruiter_lock:
                has_conflict = await self.schedule_repo.has_recruiter_conflict(
                    recruiter_id=recruiter_id,
                    start_time_iso=new_start_iso,
                    end_time_iso=new_end_iso,
                    exclude_schedule_id=interview_schedule_id,
                )
                if has_conflict:
                    alternatives = await self._build_alternative_slots_for_schedule(
                        schedule=schedule,
                        top_n=3,
                        exclude_start_iso=new_start_iso,
                    )
                    raise SchedulingConflictError(
                        "New slot conflicts with an existing recruiter meeting. Please choose another slot.",
                        suggested_slots=alternatives,
                    )

                old_confirmed_slot = schedule.get("confirmed_slot") or {}
                old_start_iso = old_confirmed_slot.get("start_time")
                old_start_dt = (
                    self._to_naive_utc(self._parse_iso_datetime(old_start_iso))
                    if old_start_iso
                    else self._utcnow_naive()
                )

                candidate_info, recruiter_info, job_info = await self._fetch_external_data(
                    schedule["candidate_id"],
                    recruiter_id,
                    schedule["job_id"]
                )

                calendar_event_id = schedule.get("calendar_event_id")
                meeting_link = schedule.get("meeting_link")
                calendar_retry_payload = {
                    "start_time": new_start_iso,
                    "end_time": new_end_iso,
                    "location": schedule.get("location") or "",
                    "notes": notes or "",
                    "interview_type": schedule.get("interview_type", "video"),
                }
                if schedule.get("interview_mode") == "synchronous":
                    recruiter_token = await self._get_recruiter_calendar_access_token(
                        recruiter_id
                    )

                    if recruiter_token:
                        try:
                            if calendar_event_id:
                                calendar_result = await asyncio.to_thread(
                                    self.google_calendar_service.update_event,
                                    access_token=recruiter_token,
                                    event_id=calendar_event_id,
                                    summary=f"Interview - {job_info.get('title', 'Position')}",
                                    description=self._build_calendar_description(
                                        candidate_info,
                                        recruiter_info,
                                        notes,
                                    ),
                                    start_time=new_start_dt,
                                    end_time=new_end_dt,
                                    attendee_emails=[
                                        candidate_info.get("email", ""),
                                        recruiter_info.get("email", ""),
                                    ],
                                    location=schedule.get("location") or None,
                                    calendar_id=self.settings.google_calendar_id,
                                )
                            else:
                                calendar_result = await asyncio.to_thread(
                                    self.google_calendar_service.create_event,
                                    access_token=recruiter_token,
                                    summary=f"Interview - {job_info.get('title', 'Position')}",
                                    description=self._build_calendar_description(
                                        candidate_info,
                                        recruiter_info,
                                        notes,
                                    ),
                                    start_time=new_start_dt,
                                    end_time=new_end_dt,
                                    attendee_emails=[
                                        candidate_info.get("email", ""),
                                        recruiter_info.get("email", ""),
                                    ],
                                    location=schedule.get("location") or None,
                                    create_meet_link=schedule.get("interview_type") in [
                                        "video",
                                        "assessment",
                                    ],
                                    calendar_id=self.settings.google_calendar_id,
                                )

                            calendar_event_id = calendar_result.get("id") or calendar_event_id
                            meeting_link = calendar_result.get("meeting_link") or meeting_link

                        except GoogleCalendarServiceError as exc:
                            await self.log_repo.log_action(
                                interview_schedule_id,
                                "calendar_error",
                                {
                                    "phase": "reschedule",
                                    "error": str(exc),
                                },
                            )
                            await self._queue_side_effect_retry(
                                job_type="calendar_reschedule",
                                interview_schedule_id=interview_schedule_id,
                                payload=calendar_retry_payload,
                                error_message=str(exc),
                            )
                    else:
                        token_error = RECRUITER_TOKEN_NOT_AVAILABLE
                        await self.log_repo.log_action(
                            interview_schedule_id,
                            "calendar_error",
                            {
                                "phase": "reschedule",
                                "error": token_error,
                            },
                        )
                        await self._queue_side_effect_retry(
                            job_type="calendar_reschedule",
                            interview_schedule_id=interview_schedule_id,
                            payload=calendar_retry_payload,
                            error_message=token_error,
                        )

                email_status = "pending"
                email_result: Dict[str, Any] = {}
                email_retry_payload = {
                    "old_start_time": old_start_iso,
                    "new_start_time": new_start_iso,
                    "duration_minutes": schedule.get("duration_minutes", 60),
                    "location": schedule.get("location") or "",
                    "notes": notes or "",
                }
                try:
                    email_result = await self.email_service.send_reschedule_notifications(
                        candidate=candidate_info,
                        recruiter=recruiter_info,
                        job_info=job_info,
                        old_start_time=old_start_dt,
                        new_start_time=new_start_dt,
                        duration_minutes=schedule.get("duration_minutes", 60),
                        location=schedule.get("location") or "",
                        notes=notes,
                        candidate_timezone=schedule.get("candidate_timezone"),
                        recruiter_timezone=schedule.get("recruiter_timezone"),
                    )
                    email_status = "sent" if email_result.get("success") else "failed"
                except EmailServiceError as exc:
                    email_status = "failed"
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "email_failed",
                        {
                            "phase": "reschedule",
                            "error": str(exc),
                        },
                    )
                    await self._queue_side_effect_retry(
                        job_type="email_reschedule",
                        interview_schedule_id=interview_schedule_id,
                        payload=email_retry_payload,
                        error_message=str(exc),
                    )

                update_data = {
                    "status": "rescheduled",
                    "confirmed_slot": {
                        "start_time": new_start_iso,
                        "end_time": new_end_iso,
                    },
                    "calendar_event_id": calendar_event_id,
                    "meeting_link": meeting_link,
                    "email_status": email_status,
                }

                if notes:
                    update_data["notes"] = notes

                success = await self.schedule_repo.update(interview_schedule_id, update_data)
                if not success:
                    raise RuntimeError(f"Failed to update schedule {interview_schedule_id}")

                await self.log_repo.log_action(
                    interview_schedule_id,
                    "interview_rescheduled",
                    {
                        "old_slot": old_confirmed_slot,
                        "new_slot": {
                            "start_time": new_start_iso,
                            "end_time": new_end_iso,
                        },
                        "calendar_event_id": calendar_event_id,
                    },
                )

                if email_status == "sent":
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "invitation_sent",
                        {
                            "phase": "reschedule",
                            "provider": email_result.get("candidate", {}).get("provider"),
                        },
                    )
                else:
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "email_failed",
                        {
                            "phase": "reschedule",
                            "details": email_result,
                        },
                    )
                    await self._queue_side_effect_retry(
                        job_type="email_reschedule",
                        interview_schedule_id=interview_schedule_id,
                        payload=email_retry_payload,
                        error_message="Reschedule email delivery reported failure",
                    )

                await self._queue_default_reminders(
                    interview_schedule_id=interview_schedule_id,
                    slot_start_iso=new_start_iso,
                )

                return {
                    "interview_schedule_id": interview_schedule_id,
                    "status": "rescheduled",
                    "message": "Interview rescheduled successfully",
                }
        
        except Exception as e:
            logger.error(f"Failed to reschedule interview: {str(e)}")
            raise
    
    async def cancel_interview(
        self,
        interview_schedule_id: str,
        reason: str
    ) -> Dict[str, Any]:
        """
        Cancel interview and propagate side effects.
        """
        logger.info(f"Cancelling interview {interview_schedule_id}")
        
        try:
            schedule = await self.schedule_repo.get_by_id(interview_schedule_id)
            if not schedule:
                raise ValueError(f"Schedule not found: {interview_schedule_id}")

            if schedule.get("status") in ["cancelled", "completed"]:
                raise ValueError(
                    f"Cannot cancel interview in status: {schedule.get('status')}"
                )

            confirmed_slot = schedule.get("confirmed_slot") or {}
            slot_start_iso = confirmed_slot.get("start_time")
            slot_start_dt = (
                self._parse_iso_datetime(slot_start_iso)
                if slot_start_iso
                else self._utcnow_naive()
            )

            candidate_info, recruiter_info, job_info = await self._fetch_external_data(
                schedule["candidate_id"],
                schedule["recruiter_id"],
                schedule["job_id"]
            )

            calendar_event_id = schedule.get("calendar_event_id")
            if schedule.get("interview_mode") == "synchronous" and calendar_event_id:
                calendar_retry_payload = {
                    "calendar_event_id": calendar_event_id,
                }
                recruiter_token = await self._get_recruiter_calendar_access_token(
                    schedule["recruiter_id"]
                )
                if recruiter_token:
                    try:
                        await asyncio.to_thread(
                            self.google_calendar_service.cancel_event,
                            access_token=recruiter_token,
                            event_id=calendar_event_id,
                            calendar_id=self.settings.google_calendar_id,
                        )
                    except GoogleCalendarServiceError as exc:
                        await self.log_repo.log_action(
                            interview_schedule_id,
                            "calendar_error",
                            {
                                "phase": "cancel",
                                "error": str(exc),
                            },
                        )
                        await self._queue_side_effect_retry(
                            job_type="calendar_cancel",
                            interview_schedule_id=interview_schedule_id,
                            payload=calendar_retry_payload,
                            error_message=str(exc),
                        )
                else:
                    token_error = RECRUITER_TOKEN_NOT_AVAILABLE
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "calendar_error",
                        {
                            "phase": "cancel",
                            "error": token_error,
                        },
                    )
                    await self._queue_side_effect_retry(
                        job_type="calendar_cancel",
                        interview_schedule_id=interview_schedule_id,
                        payload=calendar_retry_payload,
                        error_message=token_error,
                    )

            email_status = "pending"
            email_result: Dict[str, Any] = {}
            email_retry_payload = {
                "start_time": slot_start_iso,
                "reason": reason,
            }
            try:
                email_result = await self.email_service.send_cancellation_notifications(
                    candidate=candidate_info,
                    recruiter=recruiter_info,
                    job_info=job_info,
                    start_time=slot_start_dt,
                    reason=reason,
                    candidate_timezone=schedule.get("candidate_timezone"),
                    recruiter_timezone=schedule.get("recruiter_timezone"),
                )
                email_status = "sent" if email_result.get("success") else "failed"
            except EmailServiceError as exc:
                email_status = "failed"
                await self.log_repo.log_action(
                    interview_schedule_id,
                    "email_failed",
                    {
                        "phase": "cancel",
                        "error": str(exc),
                    },
                )
                await self._queue_side_effect_retry(
                    job_type="email_cancel",
                    interview_schedule_id=interview_schedule_id,
                    payload=email_retry_payload,
                    error_message=str(exc),
                )

            success = await self.schedule_repo.update(
                interview_schedule_id,
                {
                    "status": "cancelled",
                    "notes": reason,
                    "email_status": email_status,
                },
            )

            if not success:
                raise RuntimeError(f"Failed to update schedule {interview_schedule_id}")

            await self.log_repo.log_action(
                interview_schedule_id,
                "interview_cancelled",
                {
                    "reason": reason,
                    "calendar_event_id": calendar_event_id,
                },
            )

            if email_status == "sent":
                await self.log_repo.log_action(
                    interview_schedule_id,
                    "invitation_sent",
                    {
                        "phase": "cancel",
                        "provider": email_result.get("candidate", {}).get("provider"),
                    },
                )
            else:
                await self.log_repo.log_action(
                    interview_schedule_id,
                    "email_failed",
                    {
                        "phase": "cancel",
                        "details": email_result,
                    },
                )
                await self._queue_side_effect_retry(
                    job_type="email_cancel",
                    interview_schedule_id=interview_schedule_id,
                    payload=email_retry_payload,
                    error_message="Cancellation email delivery reported failure",
                )

            suggested_slots = await self._build_alternative_slots_for_schedule(
                schedule=schedule,
                top_n=3,
                exclude_start_iso=slot_start_iso,
            )
            
            return {
                "interview_schedule_id": interview_schedule_id,
                "status": "cancelled",
                "suggested_slots": suggested_slots,
                "message": (
                    "Interview cancelled successfully. "
                    "Here are alternative slots you can use to quickly reschedule."
                ),
            }
        
        except Exception as e:
            logger.error(f"Failed to cancel interview: {str(e)}")
            raise

    async def get_public_schedule_by_token(self, candidate_action_token: str) -> Dict[str, Any]:
        """Return candidate-facing schedule details using a secure token."""
        schedule = await self._get_schedule_by_candidate_token(candidate_action_token)
        schedule_id = str(schedule.get("_id"))

        return {
            "interview_schedule_id": schedule_id,
            "status": str(schedule.get("status") or "draft"),
            "interview_type": str(schedule.get("interview_type") or "video"),
            "interview_mode": str(schedule.get("interview_mode") or "synchronous"),
            "interview_stage": schedule.get("interview_stage"),
            "duration_minutes": int(schedule.get("duration_minutes") or self.settings.interview_duration_default),
            "buffer_minutes": int(schedule.get("buffer_minutes") or 0),
            "suggested_slots": list(schedule.get("suggested_slots") or []),
            "confirmed_slot": schedule.get("confirmed_slot"),
            "candidate_action_link": str(
                schedule.get("candidate_action_link")
                or self._build_candidate_action_link(candidate_action_token)
            ),
            "candidate_action_expires_at": schedule.get("candidate_action_expires_at"),
            "message": "Candidate scheduling context retrieved successfully",
        }

    async def confirm_slot_by_candidate_token(
        self,
        candidate_action_token: str,
        selected_slot: Dict[str, str],
        location: Optional[str] = None,
        notes: str = "",
    ) -> Dict[str, Any]:
        """Confirm a slot through candidate tokenized flow."""
        schedule = await self._get_schedule_by_candidate_token(candidate_action_token)
        schedule_id = str(schedule.get("_id"))
        default_location = location if location is not None else (schedule.get("location") or "")

        result = await self.confirm_slot(
            interview_schedule_id=schedule_id,
            selected_slot=selected_slot,
            location=default_location,
            notes=notes,
        )

        try:
            await self._notify_candidate_confirmation_to_node(
                schedule=schedule,
                selected_slot=selected_slot,
            )
            await self.log_repo.log_action(
                schedule_id,
                "candidate_confirmation_notified",
                {
                    "candidate_id": schedule.get("candidate_id"),
                    "recruiter_id": schedule.get("recruiter_id"),
                    "job_id": schedule.get("job_id"),
                    "slot_start": selected_slot.get("start_time"),
                },
            )
        except Exception as exc:
            logger.warning(
                "Failed to notify recruiter after candidate confirmation for schedule %s: %s",
                schedule_id,
                str(exc),
            )

        return result

    async def get_alternative_slots_by_token(
        self,
        candidate_action_token: str,
        top_n: int = 3,
    ) -> Dict[str, Any]:
        """Get optimized alternative slots for a candidate token."""
        schedule = await self._get_schedule_by_candidate_token(candidate_action_token)
        schedule_id = str(schedule.get("_id"))
        suggestions = await self._build_alternative_slots_for_schedule(
            schedule=schedule,
            top_n=max(1, min(int(top_n or 3), 10)),
            exclude_start_iso=(schedule.get("confirmed_slot") or {}).get("start_time"),
        )

        return {
            "interview_schedule_id": schedule_id,
            "suggested_slots": suggestions,
            "message": "Alternative slots generated successfully",
        }

    async def decline_slot_by_candidate_token(
        self,
        candidate_action_token: str,
        reason: str = "",
        preferred_slots: Optional[List[Dict[str, str]]] = None,
        notes: str = "",
    ) -> Dict[str, Any]:
        """Candidate declines current proposal; generate a new plan and resend scheduling email."""
        schedule = await self._get_schedule_by_candidate_token(candidate_action_token)
        schedule_id = str(schedule.get("_id"))
        preferred_slots = preferred_slots or []

        suggestions = await self._build_alternative_slots_for_schedule(
            schedule=schedule,
            top_n=5,
            exclude_start_iso=(schedule.get("confirmed_slot") or {}).get("start_time"),
            preferred_slots=preferred_slots,
        )

        if not suggestions:
            raise ValueError("No alternative slots are currently available")

        update_payload: Dict[str, Any] = {
            "status": "suggested_slots_ready",
            "suggested_slots": suggestions,
            "confirmed_slot": None,
            "calendar_event_id": None,
            "meeting_link": None,
        }

        consolidated_note = " ".join(
            part.strip() for part in [str(reason or "").strip(), str(notes or "").strip()] if part and str(part).strip()
        )
        if consolidated_note:
            update_payload["notes"] = consolidated_note

        await self.schedule_repo.update(schedule_id, update_payload)

        await self.log_repo.log_action(
            schedule_id,
            "candidate_declined_replan_requested",
            {
                "reason": reason,
                "notes": notes,
                "preferred_slots": preferred_slots,
                "generated_slots_count": len(suggestions),
            },
        )

        candidate_info, recruiter_info, job_info = await self._fetch_external_data(
            str(schedule.get("candidate_id") or ""),
            str(schedule.get("recruiter_id") or ""),
            str(schedule.get("job_id") or ""),
        )

        try:
            await self.email_service.send_replan_notifications(
                candidate=candidate_info,
                recruiter=recruiter_info,
                job_info=job_info,
                suggested_slots=suggestions,
                candidate_action_link=str(
                    schedule.get("candidate_action_link")
                    or self._build_candidate_action_link(candidate_action_token)
                ),
                reason=reason,
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )
            await self.schedule_repo.update(schedule_id, {"email_status": "sent"})
            await self.log_repo.log_action(
                schedule_id,
                "candidate_replan_email_sent",
                {
                    "suggested_slots_count": len(suggestions),
                },
            )
        except Exception as exc:
            await self.schedule_repo.update(schedule_id, {"email_status": "failed"})
            await self.log_repo.log_action(
                schedule_id,
                "email_failed",
                {
                    "phase": "candidate_decline_replan",
                    "error": str(exc),
                },
            )

        return {
            "interview_schedule_id": schedule_id,
            "status": "suggested_slots_ready",
            "suggested_slots": suggestions,
            "message": "New interview plan generated and email sent with updated options.",
        }

    async def _queue_side_effect_retry(
        self,
        job_type: str,
        interview_schedule_id: str,
        payload: Dict[str, Any],
        error_message: str,
        run_at: Optional[datetime] = None,
    ) -> Optional[str]:
        """Persist a side-effect retry job for later background processing."""
        if not self.retry_service:
            return None

        try:
            job_id = await self.retry_service.enqueue(
                job_type=job_type,
                interview_schedule_id=interview_schedule_id,
                payload=payload,
                error_message=error_message,
                run_at=run_at,
            )

            await self.log_repo.log_action(
                interview_schedule_id,
                "side_effect_retry_queued",
                {
                    "job_id": job_id,
                    "job_type": job_type,
                    "error": error_message,
                },
            )
            return job_id
        except Exception as exc:
            logger.error(
                "Failed to queue side-effect retry (%s) for schedule %s: %s",
                job_type,
                interview_schedule_id,
                str(exc),
                exc_info=True,
            )
            return None

    async def process_retry_jobs(self, max_jobs: int = 10) -> int:
        """Process a batch of due retry jobs and update their statuses."""
        if not self.retry_service:
            return 0

        processed = 0
        while processed < max(1, int(max_jobs)):
            job = await self.retry_service.claim_next_due()
            if not job:
                break

            job_id = str(job.get("_id"))
            interview_schedule_id = str(job.get("interview_schedule_id") or "")
            job_type = str(job.get("job_type") or "unknown")

            try:
                await self._execute_retry_job(job)
                await self.retry_service.mark_success(job_id)

                if interview_schedule_id:
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "side_effect_retry_succeeded",
                        {
                            "job_id": job_id,
                            "job_type": job_type,
                        },
                    )
            except Exception as exc:
                await self.retry_service.mark_failure(job_id, str(exc))

                if interview_schedule_id:
                    await self.log_repo.log_action(
                        interview_schedule_id,
                        "side_effect_retry_failed",
                        {
                            "job_id": job_id,
                            "job_type": job_type,
                            "error": str(exc),
                        },
                    )

            processed += 1

        return processed

    async def _execute_retry_job(self, job: Dict[str, Any]) -> None:
        """Execute one queued side-effect retry job."""
        job_type = str(job.get("job_type") or "")
        payload = job.get("payload") or {}
        interview_schedule_id = str(job.get("interview_schedule_id") or "")

        schedule = await self.schedule_repo.get_by_id(interview_schedule_id)
        if not schedule:
            raise ValueError(f"Schedule not found for retry job: {interview_schedule_id}")

        candidate_info, recruiter_info, job_info = await self._fetch_external_data(
            schedule["candidate_id"],
            schedule["recruiter_id"],
            schedule["job_id"],
        )

        if job_type == "calendar_confirm":
            recruiter_token = await self._get_recruiter_calendar_access_token(schedule["recruiter_id"])
            if not recruiter_token:
                raise RuntimeError("Recruiter token unavailable for calendar_confirm retry")

            start_time = self._parse_iso_datetime(str(payload.get("start_time")))
            end_time = self._parse_iso_datetime(str(payload.get("end_time")))
            calendar_result = await asyncio.to_thread(
                self.google_calendar_service.create_event,
                access_token=recruiter_token,
                summary=f"Interview - {job_info.get('title', 'Position')}",
                description=self._build_calendar_description(
                    candidate_info,
                    recruiter_info,
                    str(payload.get("notes") or ""),
                ),
                start_time=start_time,
                end_time=end_time,
                attendee_emails=[
                    candidate_info.get("email", ""),
                    recruiter_info.get("email", ""),
                ],
                location=payload.get("location") or None,
                create_meet_link=str(payload.get("interview_type") or "video") in ["video", "assessment"],
                calendar_id=self.settings.google_calendar_id,
            )

            update_data = {
                "calendar_event_id": calendar_result.get("id") or schedule.get("calendar_event_id"),
                "meeting_link": calendar_result.get("meeting_link") or schedule.get("meeting_link"),
            }
            await self.schedule_repo.update(interview_schedule_id, update_data)
            return

        if job_type == "email_confirm":
            start_time = self._parse_iso_datetime(str(payload.get("start_time")))
            result = await self.email_service.send_invitation_notifications(
                candidate=candidate_info,
                recruiter=recruiter_info,
                job_info=job_info,
                interview_type=str(payload.get("interview_type") or schedule.get("interview_type", "video")),
                interview_mode=str(payload.get("interview_mode") or schedule.get("interview_mode", "synchronous")),
                start_time=start_time,
                duration_minutes=int(payload.get("duration_minutes") or schedule.get("duration_minutes", 60)),
                location=payload.get("location") or schedule.get("location") or "",
                meeting_link=payload.get("meeting_link") or schedule.get("meeting_link"),
                notes=str(payload.get("notes") or ""),
                candidate_action_link=(
                    payload.get("candidate_action_link")
                    or schedule.get("candidate_action_link")
                ),
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )
            if not result.get("success"):
                raise EmailServiceError("Invitation retry still failing")
            await self.schedule_repo.update(interview_schedule_id, {"email_status": "sent"})
            return

        if job_type == "calendar_reschedule":
            recruiter_token = await self._get_recruiter_calendar_access_token(schedule["recruiter_id"])
            if not recruiter_token:
                raise RuntimeError("Recruiter token unavailable for calendar_reschedule retry")

            start_time = self._parse_iso_datetime(str(payload.get("start_time")))
            end_time = self._parse_iso_datetime(str(payload.get("end_time")))
            calendar_event_id = schedule.get("calendar_event_id")

            if calendar_event_id:
                calendar_result = await asyncio.to_thread(
                    self.google_calendar_service.update_event,
                    access_token=recruiter_token,
                    event_id=calendar_event_id,
                    summary=f"Interview - {job_info.get('title', 'Position')}",
                    description=self._build_calendar_description(
                        candidate_info,
                        recruiter_info,
                        str(payload.get("notes") or ""),
                    ),
                    start_time=start_time,
                    end_time=end_time,
                    attendee_emails=[
                        candidate_info.get("email", ""),
                        recruiter_info.get("email", ""),
                    ],
                    location=payload.get("location") or schedule.get("location") or None,
                    calendar_id=self.settings.google_calendar_id,
                )
            else:
                calendar_result = await asyncio.to_thread(
                    self.google_calendar_service.create_event,
                    access_token=recruiter_token,
                    summary=f"Interview - {job_info.get('title', 'Position')}",
                    description=self._build_calendar_description(
                        candidate_info,
                        recruiter_info,
                        str(payload.get("notes") or ""),
                    ),
                    start_time=start_time,
                    end_time=end_time,
                    attendee_emails=[
                        candidate_info.get("email", ""),
                        recruiter_info.get("email", ""),
                    ],
                    location=payload.get("location") or schedule.get("location") or None,
                    create_meet_link=str(payload.get("interview_type") or "video") in ["video", "assessment"],
                    calendar_id=self.settings.google_calendar_id,
                )

            await self.schedule_repo.update(
                interview_schedule_id,
                {
                    "calendar_event_id": calendar_result.get("id") or calendar_event_id,
                    "meeting_link": calendar_result.get("meeting_link") or schedule.get("meeting_link"),
                },
            )
            return

        if job_type == "email_reschedule":
            old_start_iso = payload.get("old_start_time")
            new_start_iso = payload.get("new_start_time")
            if not new_start_iso:
                raise ValueError("email_reschedule retry missing new_start_time")

            old_start_time = (
                self._parse_iso_datetime(str(old_start_iso))
                if old_start_iso
                else self._utcnow_naive()
            )
            new_start_time = self._parse_iso_datetime(str(new_start_iso))

            result = await self.email_service.send_reschedule_notifications(
                candidate=candidate_info,
                recruiter=recruiter_info,
                job_info=job_info,
                old_start_time=old_start_time,
                new_start_time=new_start_time,
                duration_minutes=int(payload.get("duration_minutes") or schedule.get("duration_minutes", 60)),
                location=payload.get("location") or schedule.get("location") or "",
                notes=str(payload.get("notes") or ""),
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )
            if not result.get("success"):
                raise EmailServiceError("Reschedule email retry still failing")
            await self.schedule_repo.update(interview_schedule_id, {"email_status": "sent"})
            return

        if job_type == "calendar_cancel":
            recruiter_token = await self._get_recruiter_calendar_access_token(schedule["recruiter_id"])
            if not recruiter_token:
                raise RuntimeError("Recruiter token unavailable for calendar_cancel retry")

            calendar_event_id = payload.get("calendar_event_id") or schedule.get("calendar_event_id")
            if not calendar_event_id:
                return

            await asyncio.to_thread(
                self.google_calendar_service.cancel_event,
                access_token=recruiter_token,
                event_id=calendar_event_id,
                calendar_id=self.settings.google_calendar_id,
            )
            return

        if job_type == "email_cancel":
            start_iso = payload.get("start_time")
            start_time = (
                self._parse_iso_datetime(str(start_iso))
                if start_iso
                else self._utcnow_naive()
            )
            result = await self.email_service.send_cancellation_notifications(
                candidate=candidate_info,
                recruiter=recruiter_info,
                job_info=job_info,
                start_time=start_time,
                reason=str(payload.get("reason") or schedule.get("notes") or "Cancelled"),
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )
            if not result.get("success"):
                raise EmailServiceError("Cancellation email retry still failing")
            await self.schedule_repo.update(interview_schedule_id, {"email_status": "sent"})
            return

        if job_type == "email_reminder":
            if str(schedule.get("status") or "") not in ["confirmed", "rescheduled"]:
                return

            confirmed_slot = schedule.get("confirmed_slot") or {}
            current_start_iso = confirmed_slot.get("start_time")
            if not current_start_iso:
                return

            target_start_iso = str(payload.get("target_start_time") or "")
            if target_start_iso and str(current_start_iso) != target_start_iso:
                # Outdated reminder (schedule was moved) - skip safely.
                return

            reminder_type = str(payload.get("reminder_type") or "24h")
            current_start_dt = self._to_naive_utc(self._parse_iso_datetime(str(current_start_iso)))
            now_dt = self._utcnow_naive()
            hours_until = (current_start_dt - now_dt).total_seconds() / 3600.0

            if reminder_type == "24h" and not (0.0 < hours_until <= 30.0):
                return
            if reminder_type == "1h" and not (0.0 < hours_until <= 2.5):
                return

            result = await self.email_service.send_interview_reminder_notifications(
                candidate=candidate_info,
                recruiter=recruiter_info,
                job_info=job_info,
                start_time=current_start_dt,
                interview_mode=str(schedule.get("interview_mode") or "synchronous"),
                location=schedule.get("location") or "",
                meeting_link=schedule.get("meeting_link") or "",
                reminder_type=reminder_type,
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )
            if not result.get("success"):
                raise EmailServiceError("Reminder email retry still failing")

            await self.log_repo.log_action(
                interview_schedule_id,
                "reminder_sent",
                {
                    "reminder_type": reminder_type,
                    "target_start_time": current_start_iso,
                },
            )
            return

        raise ValueError(f"Unsupported retry job_type: {job_type}")

    def _resolve_duration_and_buffer(
        self,
        interview_stage: str,
        duration_minutes: Optional[int],
        buffer_minutes: Optional[int],
    ) -> Tuple[int, int]:
        """Resolve duration/buffer defaults by stage while preserving explicit inputs."""
        stage_key = str(interview_stage or "technical").lower()
        stage_duration_defaults = {
            "rh": 30,
            "technical": 60,
            "final": 45,
        }
        stage_buffer_defaults = {
            "rh": 10,
            "technical": 15,
            "final": 20,
        }

        if duration_minutes is None:
            duration = int(stage_duration_defaults.get(stage_key, self.settings.interview_duration_default))
        else:
            duration = int(duration_minutes)

        if buffer_minutes is None:
            buffer = int(stage_buffer_defaults.get(stage_key, 10))
        else:
            buffer = int(buffer_minutes)

        duration = max(15, duration)
        if duration % 15 != 0:
            duration = ((duration + 14) // 15) * 15
        buffer = max(0, buffer)

        return duration, buffer

    def _build_optimization_context(
        self,
        interview_stage: str,
        job_priority: str,
        candidate_level: str,
        recruiter_preferences: Dict[str, Any],
        candidate_timezone: Optional[str],
        recruiter_timezone: Optional[str],
    ) -> Dict[str, Any]:
        """Normalize optimization context consumed by recommendation strategies."""
        preferences = recruiter_preferences if isinstance(recruiter_preferences, dict) else {}

        preferred_ranges = [
            str(item).strip()
            for item in (preferences.get("preferred_time_ranges") or [])
            if str(item).strip()
        ]
        avoid_ranges = [
            str(item).strip()
            for item in (preferences.get("avoid_time_ranges") or [])
            if str(item).strip()
        ]
        preferred_days = []
        for day in preferences.get("preferred_days") or []:
            try:
                parsed = int(day)
            except Exception:
                continue
            if 0 <= parsed <= 6:
                preferred_days.append(parsed)

        return {
            "interview_stage": str(interview_stage or "technical").lower(),
            "job_priority": str(job_priority or "normal").lower(),
            "candidate_level": str(candidate_level or "intermediate").lower(),
            "recruiter_preferences": {
                "preferred_time_ranges": preferred_ranges,
                "avoid_time_ranges": avoid_ranges,
                "preferred_days": preferred_days,
            },
            "candidate_timezone": candidate_timezone or self.settings.timezone_default,
            "recruiter_timezone": recruiter_timezone or self.settings.timezone_default,
        }

    def _build_candidate_action_link(self, candidate_action_token: str) -> str:
        """Build frontend candidate link for self-service scheduling actions."""
        token = str(candidate_action_token or "").strip()
        if not token:
            return ""

        base = str(self.settings.frontend_confirmation_url or "").rstrip("/")
        path = str(self.settings.frontend_candidate_scheduling_path or "/candidate/scheduling").strip()
        if path and not path.startswith("/"):
            path = f"/{path}"

        suffix = f"{path}?token={token}" if path else f"?token={token}"
        if base:
            return f"{base}{suffix}"
        return suffix

    def _serialize_slots(self, slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Serialize recommendation slot payload into API-friendly dictionaries."""
        serialized: List[Dict[str, Any]] = []
        for slot in slots:
            start_value = slot.get("start_time")
            end_value = slot.get("end_time")

            start_iso = (
                start_value.isoformat() if isinstance(start_value, datetime) else str(start_value)
            )
            end_iso = end_value.isoformat() if isinstance(end_value, datetime) else str(end_value)

            entry = {
                "start_time": start_iso,
                "end_time": end_iso,
                "date": slot.get("date"),
                "time_start": slot.get("time_start"),
                "time_end": slot.get("time_end"),
                "score": float(slot.get("score") or 0.0),
            }

            if slot.get("score_breakdown"):
                entry["score_breakdown"] = slot.get("score_breakdown")
            if slot.get("strategy"):
                entry["strategy"] = slot.get("strategy")
            if slot.get("days_ahead") is not None:
                entry["days_ahead"] = slot.get("days_ahead")

            serialized.append(entry)

        return serialized

    async def _get_schedule_by_candidate_token(self, candidate_action_token: str) -> Dict[str, Any]:
        """Resolve schedule by candidate token and validate token freshness."""
        token = str(candidate_action_token or "").strip()
        if not token:
            raise ValueError("Candidate action token is required")

        schedule = await self.schedule_repo.get_by_candidate_action_token(token)
        if not schedule:
            raise ValueError("Invalid candidate action token")

        expires_at = schedule.get("candidate_action_expires_at")
        if isinstance(expires_at, datetime):
            if self._to_naive_utc(expires_at) < self._utcnow_naive():
                raise ValueError("Candidate scheduling link has expired")

        return schedule

    async def _build_alternative_slots_for_schedule(
        self,
        schedule: Dict[str, Any],
        top_n: int = 3,
        exclude_start_iso: Optional[str] = None,
        preferred_slots: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Generate smart alternative slots from schedule metadata and current recruiter availability."""
        recruiter_id = str(schedule.get("recruiter_id") or "")
        if not recruiter_id:
            return []

        schedule_id = str(schedule.get("_id") or "")
        duration_minutes = int(schedule.get("duration_minutes") or self.settings.interview_duration_default)

        optimization_context = schedule.get("optimization_context")
        if not isinstance(optimization_context, dict):
            optimization_context = self._build_optimization_context(
                interview_stage=str(schedule.get("interview_stage") or "technical"),
                job_priority=str(schedule.get("job_priority") or "normal"),
                candidate_level=str(schedule.get("candidate_level") or "intermediate"),
                recruiter_preferences=schedule.get("recruiter_preferences") or {},
                candidate_timezone=schedule.get("candidate_timezone"),
                recruiter_timezone=schedule.get("recruiter_timezone"),
            )

        busy_slots = await self._get_recruiter_availability(
            recruiter_id=recruiter_id,
            exclude_schedule_id=schedule_id,
            include_tentative_suggestions=True,
        )

        generated = self.recommendation_service.generate_candidate_slots(
            recruiter_busy_slots=busy_slots,
            interview_duration=duration_minutes,
            start_date=self._utcnow_naive(),
            top_n=max(1, min(int(top_n or 3), 10)),
            optimization_context=optimization_context,
        )
        serialized = self._serialize_slots(generated)

        preferred_serialized = await self._validate_and_prepare_preferred_slots(
            recruiter_id=recruiter_id,
            preferred_slots=preferred_slots or [],
            duration_minutes=duration_minutes,
            exclude_schedule_id=schedule_id,
        )
        serialized = self._merge_slot_lists(primary=preferred_serialized, secondary=serialized)

        if exclude_start_iso:
            serialized = [
                slot
                for slot in serialized
                if str(slot.get("start_time") or "") != str(exclude_start_iso)
            ]

        return serialized[: max(1, min(int(top_n or 3), 10))]

    async def _validate_and_prepare_preferred_slots(
        self,
        recruiter_id: str,
        preferred_slots: List[Dict[str, str]],
        duration_minutes: int,
        exclude_schedule_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Validate candidate preferred windows and keep only conflict-free future slots."""
        prepared: List[Dict[str, Any]] = []
        now_utc = self._utcnow_naive()

        for slot in preferred_slots:
            start_iso = str(slot.get("start_time") or "").strip()
            end_iso = str(slot.get("end_time") or "").strip()
            if not start_iso:
                continue

            try:
                start_dt = self._to_naive_utc(self._parse_iso_datetime(start_iso))
            except Exception:
                continue

            if start_dt <= now_utc:
                continue

            if end_iso:
                try:
                    end_dt = self._to_naive_utc(self._parse_iso_datetime(end_iso))
                except Exception:
                    end_dt = start_dt + timedelta(minutes=max(15, int(duration_minutes or 60)))
            else:
                end_dt = start_dt + timedelta(minutes=max(15, int(duration_minutes or 60)))

            if end_dt <= start_dt:
                end_dt = start_dt + timedelta(minutes=max(15, int(duration_minutes or 60)))

            has_conflict = await self.schedule_repo.has_recruiter_conflict(
                recruiter_id=recruiter_id,
                start_time_iso=start_dt.isoformat(),
                end_time_iso=end_dt.isoformat(),
                exclude_schedule_id=exclude_schedule_id,
            )
            if has_conflict:
                continue

            prepared.append(
                {
                    "start_time": start_dt.isoformat(),
                    "end_time": end_dt.isoformat(),
                    "date": start_dt.strftime("%Y-%m-%d"),
                    "time_start": start_dt.strftime("%H:%M"),
                    "time_end": end_dt.strftime("%H:%M"),
                    "score": 9.9,
                    "strategy": "candidate_preference",
                }
            )

        return prepared

    @staticmethod
    def _merge_slot_lists(primary: List[Dict[str, Any]], secondary: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Merge slot lists by start/end keys while preserving first-seen priority."""
        merged: List[Dict[str, Any]] = []
        seen = set()

        for slot in list(primary or []) + list(secondary or []):
            key = f"{str(slot.get('start_time') or '')}|{str(slot.get('end_time') or '')}"
            if not key.strip("|"):
                continue
            if key in seen:
                continue
            seen.add(key)
            merged.append(slot)

        return merged

    async def _queue_default_reminders(self, interview_schedule_id: str, slot_start_iso: str) -> None:
        """Schedule 24h and 1h reminders as delayed retry jobs."""
        if not self.retry_service:
            return

        try:
            slot_start_dt = self._to_naive_utc(self._parse_iso_datetime(str(slot_start_iso)))
        except Exception:
            return

        now_dt = self._utcnow_naive()
        if slot_start_dt <= now_dt:
            return

        reminder_plan = [
            ("24h", 24, bool(self.settings.reminder_24h_enabled)),
            ("1h", 1, bool(self.settings.reminder_1h_enabled)),
        ]

        for reminder_type, offset_hours, enabled in reminder_plan:
            if not enabled:
                continue

            run_at = slot_start_dt - timedelta(hours=offset_hours)
            if run_at <= now_dt:
                continue

            payload = {
                "reminder_type": reminder_type,
                "target_start_time": str(slot_start_iso),
            }

            job_id = await self._queue_side_effect_retry(
                job_type="email_reminder",
                interview_schedule_id=interview_schedule_id,
                payload=payload,
                error_message=f"Scheduled {reminder_type} reminder job",
                run_at=run_at,
            )
            if job_id:
                await self.log_repo.log_action(
                    interview_schedule_id,
                    "reminder_scheduled",
                    {
                        "reminder_type": reminder_type,
                        "run_at": run_at.isoformat(),
                        "job_id": job_id,
                    },
                )
    
    async def _fetch_external_data(
        self,
        candidate_id: str,
        recruiter_id: str,
        job_id: str
    ) -> tuple:
        """
        Fetch candidate, recruiter and job metadata from Node backend.
        """
        logger.debug("Fetching external data from Node backend")
        
        try:
            base_url = self.settings.node_backend_url.rstrip("/")
            timeout = self.settings.node_http_timeout_seconds
            internal_endpoint = self.settings.node_internal_scheduling_path.rstrip("/")

            candidate_info = {
                "id": candidate_id,
                "name": "Candidate",
                "email": "",
            }
            recruiter_info = {
                "id": recruiter_id,
                "name": "Recruiter",
                "email": "",
            }
            job_info = {
                "id": job_id,
                "title": "Position",
                "department": "",
            }

            # Preferred path: get a consistent payload from Node internal endpoint.
            api_key = self.settings.node_internal_api_key or self.settings.api_key
            headers = {}
            if api_key:
                headers["x-internal-api-key"] = api_key

            context_url = (
                f"{base_url}{internal_endpoint}/context"
                f"?candidateId={candidate_id}&recruiterId={recruiter_id}&jobId={job_id}"
            )

            async with httpx.AsyncClient(timeout=timeout) as client:
                context_resp = await client.get(context_url, headers=headers)

            if context_resp.status_code == 200:
                payload = context_resp.json()
                candidate_payload = payload.get("candidate") or {}
                recruiter_payload = payload.get("recruiter") or {}
                job_payload = payload.get("job") or {}

                candidate_info = {
                    "id": str(candidate_payload.get("id") or candidate_id),
                    "name": candidate_payload.get("name") or "Candidate",
                    "email": candidate_payload.get("email") or "",
                }
                recruiter_info = {
                    "id": str(recruiter_payload.get("id") or recruiter_id),
                    "name": recruiter_payload.get("name") or "Recruiter",
                    "email": recruiter_payload.get("email") or "",
                }
                job_info = {
                    "id": str(job_payload.get("id") or job_id),
                    "title": job_payload.get("title") or "Position",
                    "department": job_payload.get("department") or "",
                }
                return candidate_info, recruiter_info, job_info

            async with httpx.AsyncClient(timeout=timeout) as client:
                candidate_task = client.get(f"{base_url}/api/users/{candidate_id}")
                recruiter_task = client.get(f"{base_url}/api/users/{recruiter_id}")
                job_task = client.get(f"{base_url}/api/job/{job_id}")

                candidate_resp, recruiter_resp, job_resp = await asyncio.gather(
                    candidate_task,
                    recruiter_task,
                    job_task,
                    return_exceptions=True,
                )

            if isinstance(candidate_resp, httpx.Response) and candidate_resp.status_code < 400:
                candidate_payload = candidate_resp.json()
                candidate_info = {
                    "id": str(candidate_payload.get("_id", candidate_id)),
                    "name": candidate_payload.get("name") or "Candidate",
                    "email": candidate_payload.get("email") or "",
                }

            if isinstance(recruiter_resp, httpx.Response) and recruiter_resp.status_code < 400:
                recruiter_payload = recruiter_resp.json()
                recruiter_info = {
                    "id": str(recruiter_payload.get("_id", recruiter_id)),
                    "name": recruiter_payload.get("name") or "Recruiter",
                    "email": recruiter_payload.get("email") or "",
                }

            if isinstance(job_resp, httpx.Response) and job_resp.status_code < 400:
                job_payload = job_resp.json()
                job_info = {
                    "id": job_id,
                    "title": job_payload.get("title") or "Position",
                    "department": job_payload.get("industry") or "",
                }

            return candidate_info, recruiter_info, job_info
        
        except Exception as e:
            logger.error(f"Failed to fetch external data: {str(e)}")
            return (
                {
                    "id": candidate_id,
                    "name": "Candidate",
                    "email": "",
                },
                {
                    "id": recruiter_id,
                    "name": "Recruiter",
                    "email": "",
                },
                {
                    "id": job_id,
                    "title": "Position",
                    "department": "",
                },
            )

    async def _notify_candidate_confirmation_to_node(
        self,
        schedule: Dict[str, Any],
        selected_slot: Dict[str, str],
    ) -> None:
        """Push recruiter notification to Node backend after candidate confirms attendance."""
        base_url = self.settings.node_backend_url.rstrip("/")
        internal_endpoint = self.settings.node_internal_scheduling_path.rstrip("/")
        url = f"{base_url}{internal_endpoint}/candidate-confirmation"

        headers = {}
        api_key = self.settings.node_internal_api_key or self.settings.api_key
        if api_key:
            headers["x-internal-api-key"] = api_key

        payload = {
            "interviewScheduleId": str(schedule.get("_id") or ""),
            "candidateId": str(schedule.get("candidate_id") or ""),
            "recruiterId": str(schedule.get("recruiter_id") or ""),
            "jobId": str(schedule.get("job_id") or ""),
            "confirmedSlot": {
                "start_time": selected_slot.get("start_time"),
                "end_time": selected_slot.get("end_time"),
            },
        }

        async with httpx.AsyncClient(timeout=self.settings.node_http_timeout_seconds) as client:
            response = await client.post(url, json=payload, headers=headers)

        if response.status_code >= 400:
            raise RuntimeError(
                f"Node candidate confirmation notification failed ({response.status_code}): {response.text}"
            )

    async def _get_recruiter_calendar_access_token(self, recruiter_id: str) -> Optional[str]:
        """Fetch recruiter access token from Node internal endpoint or fallback env var."""
        base_url = self.settings.node_backend_url.rstrip("/")
        endpoint = self.settings.node_internal_scheduling_path.rstrip("/")
        url = f"{base_url}{endpoint}/google-token/{recruiter_id}"

        api_key = self.settings.node_internal_api_key or self.settings.api_key
        headers = {}
        if api_key:
            headers["x-internal-api-key"] = api_key

        try:
            async with httpx.AsyncClient(timeout=self.settings.node_http_timeout_seconds) as client:
                response = await client.get(url, headers=headers)

            if response.status_code == 200:
                payload = response.json()
                access_token = payload.get("access_token")
                if access_token:
                    return access_token

            logger.warning(
                "Could not fetch recruiter token for %s from Node endpoint: %s",
                recruiter_id,
                response.status_code,
            )
        except Exception as exc:
            logger.warning(
                "Internal token endpoint failed for recruiter %s: %s",
                recruiter_id,
                str(exc),
            )

        if self.settings.google_access_token_fallback:
            return self.settings.google_access_token_fallback

        return None
    
    async def _get_recruiter_availability(
        self,
        recruiter_id: str,
        exclude_schedule_id: Optional[str] = None,
        include_tentative_suggestions: bool = False,
    ) -> List[tuple]:
        """
        Get recruiter busy slots from Google Calendar when token is available.
        """
        logger.debug(f"Fetching recruiter availability for {recruiter_id}")

        internal_busy_slots = await self._get_internal_recruiter_busy_slots(
            recruiter_id=recruiter_id,
            exclude_schedule_id=exclude_schedule_id,
            include_tentative_suggestions=include_tentative_suggestions,
        )

        recruiter_token = await self._get_recruiter_calendar_access_token(recruiter_id)
        if not recruiter_token:
            return internal_busy_slots

        start = self._utcnow_naive()
        end = start + timedelta(days=self.settings.scheduling_days_ahead)

        try:
            busy_slots: List[Tuple[datetime, datetime]] = await asyncio.to_thread(
                self.google_calendar_service.get_busy_slots,
                access_token=recruiter_token,
                start_time=start,
                end_time=end,
                calendar_id=self.settings.google_calendar_id,
            )
            return self._merge_busy_slots(internal_busy_slots + busy_slots)
        except GoogleCalendarServiceError as exc:
            logger.warning(
                "Failed to fetch recruiter %s availability from Google Calendar: %s",
                recruiter_id,
                str(exc),
            )
            return internal_busy_slots

    async def _get_internal_recruiter_busy_slots(
        self,
        recruiter_id: str,
        exclude_schedule_id: Optional[str] = None,
        include_tentative_suggestions: bool = False,
    ) -> List[Tuple[datetime, datetime]]:
        """Collect busy slots from internal schedules (confirmed and optional tentative)."""
        schedules = await self.schedule_repo.get_by_recruiter(recruiter_id)
        busy_slots: List[Tuple[datetime, datetime]] = []

        for schedule in schedules:
            schedule_id = str(schedule.get("_id") or "")
            if exclude_schedule_id and schedule_id == str(exclude_schedule_id):
                continue

            status = str(schedule.get("status") or "")

            if status in ["confirmed", "rescheduled"]:
                confirmed_slot = schedule.get("confirmed_slot") or {}
                start_iso = confirmed_slot.get("start_time")
                end_iso = confirmed_slot.get("end_time")
                if not start_iso or not end_iso:
                    continue

                try:
                    start_dt = self._to_naive_utc(self._parse_iso_datetime(str(start_iso)))
                    end_dt = self._to_naive_utc(self._parse_iso_datetime(str(end_iso)))
                    if end_dt > start_dt:
                        busy_slots.append((start_dt, end_dt))
                except Exception:
                    continue

            if (
                include_tentative_suggestions
                and status == "suggested_slots_ready"
                and self._is_recent_tentative_schedule(schedule)
            ):
                suggested_slots = schedule.get("suggested_slots") or []
                for slot in suggested_slots[: max(1, self._tentative_slots_per_schedule)]:
                    start_iso = slot.get("start_time")
                    end_iso = slot.get("end_time")
                    if not start_iso or not end_iso:
                        continue

                    try:
                        start_dt = self._to_naive_utc(self._parse_iso_datetime(str(start_iso)))
                        end_dt = self._to_naive_utc(self._parse_iso_datetime(str(end_iso)))
                        if end_dt > start_dt:
                            busy_slots.append((start_dt, end_dt))
                    except Exception:
                        continue

        return self._merge_busy_slots(busy_slots)

    @staticmethod
    def _merge_busy_slots(
        busy_slots: List[Tuple[datetime, datetime]],
    ) -> List[Tuple[datetime, datetime]]:
        """Merge overlapping busy windows into non-overlapping intervals."""
        if not busy_slots:
            return []

        ordered = sorted(busy_slots, key=lambda item: item[0])
        merged: List[Tuple[datetime, datetime]] = [ordered[0]]

        for current_start, current_end in ordered[1:]:
            prev_start, prev_end = merged[-1]
            if current_start <= prev_end:
                merged[-1] = (prev_start, max(prev_end, current_end))
            else:
                merged.append((current_start, current_end))

        return merged

    def _get_recruiter_lock(self, recruiter_id: str) -> asyncio.Lock:
        """Return a shared in-process lock for a recruiter."""
        lock = self._recruiter_locks.get(recruiter_id)
        if lock is None:
            lock = asyncio.Lock()
            self._recruiter_locks[recruiter_id] = lock
        return lock

    def _is_recent_tentative_schedule(self, schedule: Dict[str, Any]) -> bool:
        """Treat fresh suggested slots as temporary reservations to reduce duplicate suggestions."""
        ref_time = schedule.get("updated_at") or schedule.get("created_at")
        if not isinstance(ref_time, datetime):
            return False

        now = self._utcnow_naive()
        ref = self._to_naive_utc(ref_time)
        return (now - ref) <= timedelta(minutes=max(1, self._tentative_slot_hold_minutes))

    @staticmethod
    def _parse_iso_datetime(value: str) -> datetime:
        """Parse ISO datetime strings including Z suffix."""
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)

    @staticmethod
    def _to_naive_utc(value: datetime) -> datetime:
        """Normalize aware/naive datetimes to naive UTC for compatibility."""
        if value.tzinfo:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    @staticmethod
    def _build_calendar_description(
        candidate_info: Dict[str, Any],
        recruiter_info: Dict[str, Any],
        notes: str,
    ) -> str:
        """Build a compact event description for calendar entries."""
        description_lines = [
            "Interview scheduled via AI Recruiter Platform.",
            f"Candidate: {candidate_info.get('name', 'Candidate')} ({candidate_info.get('email', 'N/A')})",
            f"Recruiter: {recruiter_info.get('name', 'Recruiter')} ({recruiter_info.get('email', 'N/A')})",
        ]
        if notes:
            description_lines.append(f"Notes: {notes}")
        return "\n".join(description_lines)

    @staticmethod
    def _utcnow_naive() -> datetime:
        """Return UTC datetime as naive value to stay compatible with Phase 1 logic."""
        return datetime.now(timezone.utc).replace(tzinfo=None)


def create_orchestrator(
    schedule_repo: InterviewScheduleRepository,
    log_repo: ScheduleLogRepository,
    recommendation_service: RecommendationService,
    google_calendar_service: GoogleCalendarService,
    email_service: EmailService,
    retry_service: SideEffectRetryService,
    settings: Settings
) -> SchedulingOrchestrator:
    """
    Factory function to create SchedulingOrchestrator.
    
    Args:
        schedule_repo: Interview schedule repository
        log_repo: Schedule log repository
        recommendation_service: Recommendation service
        settings: Application settings
        
    Returns:
        SchedulingOrchestrator: Initialized orchestrator
    """
    return SchedulingOrchestrator(
        schedule_repo,
        log_repo,
        recommendation_service,
        google_calendar_service,
        email_service,
        retry_service,
        settings
    )
