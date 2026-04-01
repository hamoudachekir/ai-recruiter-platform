import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional, Tuple

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
        duration_minutes: int
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
            schedule_data = {
                "candidate_id": candidate_id,
                "recruiter_id": recruiter_id,
                "job_id": job_id,
                "application_id": application_id,
                "interview_type": interview_type,
                "interview_mode": interview_mode,
                "duration_minutes": duration_minutes,
                "status": "draft",
                "email_status": "pending",
                "suggested_slots": [],
                "confirmed_slot": None,
                "calendar_event_id": None,
                "meeting_link": None,
                "location": None,
                "notes": ""
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
                    interview_duration=duration_minutes,
                    start_date=self._utcnow_naive(),
                    top_n=5
                )

                suggested_slots_data = [
                    {
                        "start_time": slot["start_time"].isoformat(),
                        "end_time": slot["end_time"].isoformat(),
                        "date": slot["date"],
                        "time_start": slot["time_start"],
                        "time_end": slot["time_end"],
                        "score": slot["score"]
                    }
                    for slot in suggested_slots
                ]

                await self.schedule_repo.update(schedule_id, {
                    "status": "suggested_slots_ready",
                    "suggested_slots": suggested_slots_data
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
                        ]
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
                    raise ValueError(
                        "Selected slot conflicts with an existing recruiter meeting. "
                        "Please choose another slot."
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
                        token_error = "Recruiter Google token not available"
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
                email_retry_payload = {
                    "start_time": slot_start_iso,
                    "duration_minutes": schedule.get("duration_minutes", 60),
                    "location": location or "",
                    "notes": notes or "",
                    "meeting_link": meeting_link or "",
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

                logger.info(f"Confirmed interview schedule {interview_schedule_id}")
            
            return {
                "interview_schedule_id": interview_schedule_id,
                "status": "confirmed",
                "calendar_event_id": calendar_event_id,
                "meeting_link": meeting_link,
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
                    raise ValueError(
                        "New slot conflicts with an existing recruiter meeting. "
                        "Please choose another slot."
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
                        token_error = "Recruiter Google token not available"
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
                    token_error = "Recruiter Google token not available"
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
            
            return {
                "interview_schedule_id": interview_schedule_id,
                "status": "cancelled",
                "message": "Interview cancelled successfully"
            }
        
        except Exception as e:
            logger.error(f"Failed to cancel interview: {str(e)}")
            raise

    async def _queue_side_effect_retry(
        self,
        job_type: str,
        interview_schedule_id: str,
        payload: Dict[str, Any],
        error_message: str,
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
            )
            if not result.get("success"):
                raise EmailServiceError("Cancellation email retry still failing")
            await self.schedule_repo.update(interview_schedule_id, {"email_status": "sent"})
            return

        raise ValueError(f"Unsupported retry job_type: {job_type}")
    
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
