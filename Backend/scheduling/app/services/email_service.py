import asyncio
import logging
import smtplib
from datetime import datetime, timezone, tzinfo
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from app.config import Settings
from app.services.template_service import TemplateService

logger = logging.getLogger(__name__)


class EmailServiceError(Exception):
    """Raised when email delivery fails."""


class EmailService:
    """Handles email delivery with SMTP or SendGrid."""

    def __init__(self, settings: Settings, template_service: TemplateService):
        self.settings = settings
        self.template_service = template_service

    def _resolve_provider(self) -> str:
        has_smtp = bool(self.settings.smtp_host and self.settings.smtp_port)
        has_sendgrid = bool(self.settings.sendgrid_api_key)

        if self.settings.email_provider == "smtp":
            if not has_smtp:
                raise EmailServiceError("SMTP selected but SMTP configuration is missing")
            return "smtp"

        if self.settings.email_provider == "sendgrid":
            if not has_sendgrid:
                raise EmailServiceError("SendGrid selected but API key is missing")
            return "sendgrid"

        if has_smtp:
            return "smtp"
        if has_sendgrid:
            return "sendgrid"

        raise EmailServiceError("No email provider configured")

    def _resolve_target_timezone(self, timezone_name: Optional[str] = None) -> tuple[tzinfo, str]:
        """Resolve the display timezone used in emails.

        Priority:
        1) explicit timezone argument (when valid and not UTC)
        2) configured default timezone (when valid and not UTC)
        3) host local timezone
        4) UTC fallback
        """
        explicit_name = str(timezone_name or "").strip()
        configured_name = str(self.settings.timezone_default or "").strip()

        preferred_names: List[str] = []
        if explicit_name:
            preferred_names.append(explicit_name)
        if configured_name and configured_name not in preferred_names:
            preferred_names.append(configured_name)

        for candidate in preferred_names:
            if candidate.upper() == "UTC":
                continue
            try:
                return ZoneInfo(candidate), candidate
            except ZoneInfoNotFoundError:
                logger.warning("Unknown timezone '%s' in scheduling email formatter", candidate)

        local_tz = datetime.now().astimezone().tzinfo
        if local_tz and local_tz != timezone.utc:
            return local_tz, local_tz.tzname(None) or "Local Time"

        return timezone.utc, "UTC"

    def _format_datetime(self, value: datetime, timezone_name: Optional[str] = None) -> Dict[str, str]:
        target_tz, fallback_label = self._resolve_target_timezone(timezone_name)

        # Scheduling service stores naive datetimes as UTC by convention.
        if value.tzinfo:
            utc_value = value.astimezone(timezone.utc)
        else:
            utc_value = value.replace(tzinfo=timezone.utc)

        localized = utc_value.astimezone(target_tz)
        timezone_label = localized.tzname() or fallback_label

        return {
            "date": localized.strftime("%A, %B %d, %Y"),
            "time": localized.strftime("%H:%M"),
            "timezone": timezone_label,
        }

    async def _send_with_smtp(self, recipient: str, subject: str, html_content: str, text_content: str) -> None:
        await asyncio.to_thread(
            self._send_with_smtp_sync,
            recipient,
            subject,
            html_content,
            text_content,
        )

    def _send_with_smtp_sync(self, recipient: str, subject: str, html_content: str, text_content: str) -> None:
        from_email = self.settings.email_from
        msg = MIMEMultipart("alternative")
        msg["From"] = formataddr((self.settings.email_from_name, from_email))
        msg["To"] = recipient
        msg["Subject"] = subject

        if text_content:
            msg.attach(MIMEText(text_content, "plain", "utf-8"))
        msg.attach(MIMEText(html_content, "html", "utf-8"))

        with smtplib.SMTP(self.settings.smtp_host, self.settings.smtp_port, timeout=30) as server:
            if self.settings.smtp_use_tls:
                server.starttls()

            if self.settings.smtp_username and self.settings.smtp_password:
                server.login(self.settings.smtp_username, self.settings.smtp_password)

            server.sendmail(from_email, [recipient], msg.as_string())

    async def _send_with_sendgrid(self, recipient: str, subject: str, html_content: str, text_content: str) -> None:
        from_email = self.settings.sendgrid_from_email or self.settings.email_from
        payload = {
            "personalizations": [{"to": [{"email": recipient}]}],
            "from": {
                "email": from_email,
                "name": self.settings.email_from_name,
            },
            "subject": subject,
            "content": [
                {"type": "text/plain", "value": text_content or " "},
                {"type": "text/html", "value": html_content},
            ],
        }

        headers = {
            "Authorization": f"Bearer {self.settings.sendgrid_api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=payload,
                headers=headers,
            )

        if response.status_code >= 400:
            raise EmailServiceError(
                f"SendGrid request failed with status {response.status_code}: {response.text}"
            )

    async def send_email_batch(
        self,
        recipients: List[str],
        subject: str,
        html_content: str,
        text_content: str = "",
    ) -> Dict[str, Any]:
        provider = self._resolve_provider()
        sent_to: List[str] = []
        failed: List[Dict[str, str]] = []

        for recipient in recipients:
            if not recipient:
                failed.append({"email": "", "error": "Missing recipient email"})
                continue

            try:
                if provider == "smtp":
                    await self._send_with_smtp(recipient, subject, html_content, text_content)
                else:
                    await self._send_with_sendgrid(recipient, subject, html_content, text_content)

                sent_to.append(recipient)

            except Exception as exc:
                logger.error("Failed to send email to %s: %s", recipient, str(exc))
                failed.append({"email": recipient, "error": str(exc)})

        return {
            "provider": provider,
            "success": len(failed) == 0,
            "sent_to": sent_to,
            "failed": failed,
        }

    async def send_invitation_notifications(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        interview_type: str,
        interview_mode: str,
        start_time: datetime,
        duration_minutes: int,
        location: Optional[str],
        meeting_link: Optional[str],
        notes: str = "",
        candidate_action_link: Optional[str] = None,
        candidate_timezone: Optional[str] = None,
        recruiter_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        candidate_dt = self._format_datetime(start_time, candidate_timezone)
        recruiter_dt = self._format_datetime(start_time, recruiter_timezone)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "interview_type": interview_type,
            "interview_mode": interview_mode,
            "interview_date": candidate_dt["date"],
            "interview_time": candidate_dt["time"],
            "interview_timezone": candidate_dt["timezone"],
            "interview_duration": duration_minutes,
            "recruiter_name": recruiter.get("name", "Recruiter"),
            "location": location or "",
            "meeting_link": meeting_link or "",
            "instructions": notes or "Please be available at the scheduled time.",
            "tips": [
                "Join 5 minutes early.",
                "Ensure your internet and camera are working.",
                "Review your CV and the job description.",
            ],
            "confirmation_link": candidate_action_link or self.settings.frontend_confirmation_url,
            "company_name": self.settings.email_from_name,
        }

        candidate_html = self.template_service.render("interview_invitation.html", candidate_context)

        candidate_subject = f"Interview Invitation - {job_info.get('title', 'Position')}"
        candidate_text = (
            f"Your interview is scheduled on {candidate_dt['date']} at {candidate_dt['time']} ({candidate_dt['timezone']})."
        )

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=candidate_subject,
            html_content=candidate_html,
            text_content=candidate_text,
        )

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p>An interview has been confirmed for <strong>{candidate_name}</strong>.</p>"
            "<ul>"
            "<li>Job: {job_title}</li>"
            "<li>Date: {date}</li>"
            "<li>Time: {time}</li>"
            "<li>Timezone: {timezone}</li>"
            "<li>Duration: {duration} minutes</li>"
            "<li>Meeting Link: {meeting_link}</li>"
            "</ul>"
            "<p>Please check your calendar for the event details.</p>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            job_title=job_info.get("title", "Position"),
            date=recruiter_dt["date"],
            time=recruiter_dt["time"],
            timezone=recruiter_dt["timezone"],
            duration=duration_minutes,
            meeting_link=meeting_link or "N/A",
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Interview Confirmed - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content="Interview has been confirmed and added to your calendar.",
        )

        return {
            "success": candidate_result["success"] and recruiter_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
        }

    async def send_interview_reminder_notifications(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        start_time: datetime,
        interview_mode: str,
        location: Optional[str],
        meeting_link: Optional[str],
        reminder_type: str,
        candidate_timezone: Optional[str] = None,
        recruiter_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send reminder emails to candidate and recruiter (24h / 1h)."""
        reminder_label = "24 hours" if reminder_type == "24h" else "1 hour"
        candidate_dt = self._format_datetime(start_time, candidate_timezone)
        recruiter_dt = self._format_datetime(start_time, recruiter_timezone)

        candidate_html = (
            "<p>Hello {name},</p>"
            "<p>This is a reminder: your interview for <strong>{job}</strong> starts in <strong>{label}</strong>.</p>"
            "<ul>"
            "<li>Date: {date}</li>"
            "<li>Time: {time}</li>"
            "<li>Timezone: {timezone}</li>"
            "<li>Mode: {mode}</li>"
            "<li>Location: {location}</li>"
            "<li>Meeting link: {meeting}</li>"
            "</ul>"
            "<p>Please be ready a few minutes before the start time.</p>"
        ).format(
            name=candidate.get("name", "Candidate"),
            job=job_info.get("title", "Position"),
            label=reminder_label,
            date=candidate_dt["date"],
            time=candidate_dt["time"],
            timezone=candidate_dt["timezone"],
            mode=interview_mode,
            location=location or "N/A",
            meeting=meeting_link or "N/A",
        )

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Reminder: Interview in {reminder_label} - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content=(
                f"Reminder: your interview starts in {reminder_label} on {candidate_dt['date']} at {candidate_dt['time']} ({candidate_dt['timezone']})."
            ),
        )

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p>Reminder: interview with <strong>{candidate}</strong> starts in <strong>{label}</strong>.</p>"
            "<ul>"
            "<li>Role: {job}</li>"
            "<li>Date: {date}</li>"
            "<li>Time: {time}</li>"
            "<li>Timezone: {timezone}</li>"
            "<li>Mode: {mode}</li>"
            "<li>Meeting link: {meeting}</li>"
            "</ul>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate=candidate.get("name", "Candidate"),
            label=reminder_label,
            job=job_info.get("title", "Position"),
            date=recruiter_dt["date"],
            time=recruiter_dt["time"],
            timezone=recruiter_dt["timezone"],
            mode=interview_mode,
            meeting=meeting_link or "N/A",
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Recruiter reminder: Interview in {reminder_label} - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content="Reminder sent for upcoming interview.",
        )

        return {
            "success": candidate_result["success"] and recruiter_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
            "reminder_type": reminder_type,
        }

    async def send_reschedule_notifications(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        old_start_time: datetime,
        new_start_time: datetime,
        duration_minutes: int,
        location: Optional[str],
        notes: str,
        candidate_timezone: Optional[str] = None,
        recruiter_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        old_dt = self._format_datetime(old_start_time, candidate_timezone)
        new_dt = self._format_datetime(new_start_time, candidate_timezone)
        recruiter_old_dt = self._format_datetime(old_start_time, recruiter_timezone)
        recruiter_new_dt = self._format_datetime(new_start_time, recruiter_timezone)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "old_interview_date": old_dt["date"],
            "old_interview_time": old_dt["time"],
            "new_interview_date": new_dt["date"],
            "new_interview_time": new_dt["time"],
            "interview_timezone": new_dt["timezone"],
            "interview_duration": duration_minutes,
            "location": location or "",
            "reschedule_reason": notes,
            "confirmation_link": self.settings.frontend_confirmation_url,
            "company_name": self.settings.email_from_name,
        }

        candidate_html = self.template_service.render("interview_rescheduled.html", candidate_context)

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Interview Rescheduled - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content=(
                f"Your interview has been moved to {new_dt['date']} at {new_dt['time']}."
            ),
        )

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p>The interview with <strong>{candidate_name}</strong> has been rescheduled.</p>"
            "<ul>"
            "<li>Old time: {old_date} {old_time}</li>"
            "<li>New time: {new_date} {new_time}</li>"
            "<li>Timezone: {timezone}</li>"
            "<li>Reason: {reason}</li>"
            "</ul>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            old_date=recruiter_old_dt["date"],
            old_time=recruiter_old_dt["time"],
            new_date=recruiter_new_dt["date"],
            new_time=recruiter_new_dt["time"],
            timezone=recruiter_new_dt["timezone"],
            reason=notes or "Not provided",
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Interview Rescheduled - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content="Interview time has been updated.",
        )

        return {
            "success": candidate_result["success"] and recruiter_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
        }

    async def send_cancellation_notifications(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        start_time: datetime,
        reason: str,
        candidate_timezone: Optional[str] = None,
        recruiter_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        slot_dt = self._format_datetime(start_time, candidate_timezone)
        recruiter_dt = self._format_datetime(start_time, recruiter_timezone)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "interview_date": slot_dt["date"],
            "interview_time": slot_dt["time"],
            "interview_timezone": slot_dt["timezone"],
            "cancellation_reason": reason,
            "allow_rescheduling": True,
            "contact_email": self.settings.email_from,
            "company_name": self.settings.email_from_name,
        }

        candidate_html = self.template_service.render("interview_cancelled.html", candidate_context)

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Interview Cancelled - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content=f"Your interview has been cancelled. Reason: {reason}",
        )

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p>The interview with <strong>{candidate_name}</strong> has been cancelled.</p>"
            "<ul>"
            "<li>Date: {date}</li>"
            "<li>Time: {time}</li>"
            "<li>Timezone: {timezone}</li>"
            "<li>Reason: {reason}</li>"
            "</ul>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            date=recruiter_dt["date"],
            time=recruiter_dt["time"],
            timezone=recruiter_dt["timezone"],
            reason=reason,
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Interview Cancelled - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content=f"Interview cancelled: {reason}",
        )

        return {
            "success": candidate_result["success"] and recruiter_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
        }

    async def send_replan_notifications(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        suggested_slots: List[Dict[str, Any]],
        candidate_action_link: str,
        reason: str = "",
        candidate_timezone: Optional[str] = None,
        recruiter_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a new planning email after candidate declines the previously proposed interview time."""
        safe_slots = list(suggested_slots or [])[:3]

        def _format_slots(slots: List[Dict[str, Any]], tz_name: Optional[str]) -> str:
            lines: List[str] = []
            for index, slot in enumerate(slots, start=1):
                start_raw = slot.get("start_time")
                if not start_raw:
                    continue

                try:
                    start_dt = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
                    if start_dt.tzinfo:
                        start_dt = start_dt.astimezone(timezone.utc).replace(tzinfo=None)
                    formatted = self._format_datetime(start_dt, tz_name)
                    lines.append(
                        f"<li>Option {index}: {formatted['date']} at {formatted['time']} ({formatted['timezone']})</li>"
                    )
                except Exception:
                    lines.append(f"<li>Option {index}: {start_raw}</li>")

            return "".join(lines) if lines else "<li>No immediate slot available</li>"

        candidate_slots_html = _format_slots(safe_slots, candidate_timezone)
        recruiter_slots_html = _format_slots(safe_slots, recruiter_timezone)

        candidate_reason_html = ""
        if str(reason or "").strip():
            candidate_reason_html = (
                f"<p><strong>Your note:</strong> {str(reason).strip()}</p>"
            )

        candidate_html = (
            "<p>Hello {name},</p>"
            "<p>We received your request to change the interview time for <strong>{job}</strong>.</p>"
            "{reason_html}"
            "<p>Our scheduling engine generated a new plan. Here are the best alternatives:</p>"
            "<ul>{slots}</ul>"
            "<p>Please select and confirm your preferred slot here:</p>"
            "<p><a href=\"{link}\">Open scheduling page</a></p>"
            "<p>Thank you.</p>"
        ).format(
            name=candidate.get("name", "Candidate"),
            job=job_info.get("title", "Position"),
            reason_html=candidate_reason_html,
            slots=candidate_slots_html,
            link=candidate_action_link,
        )

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Updated interview options - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content="New interview options are available. Please open your scheduling link.",
        )

        recruiter_reason_html = ""
        if str(reason or "").strip():
            recruiter_reason_html = f"<p><strong>Candidate reason:</strong> {str(reason).strip()}</p>"

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p>The candidate <strong>{candidate_name}</strong> cannot attend the previous interview time for <strong>{job}</strong>.</p>"
            "{reason_html}"
            "<p>A new scheduling plan was generated:</p>"
            "<ul>{slots}</ul>"
            "<p>Candidate self-service link: <a href=\"{link}\">open link</a></p>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            job=job_info.get("title", "Position"),
            reason_html=recruiter_reason_html,
            slots=recruiter_slots_html,
            link=candidate_action_link,
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Candidate requested rescheduling - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content="Candidate requested a new interview schedule. Updated alternatives have been generated.",
        )

        return {
            "success": candidate_result["success"] and recruiter_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
        }

    async def send_recruiter_reschedule_request_notification(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        current_start_time: datetime,
        requested_start_time: datetime,
        duration_minutes: int,
        approve_link: str,
        decline_link: str,
        reason: str = "",
        recruiter_timezone: Optional[str] = None,
        candidate_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Notify recruiter that candidate requested date/time change and ask for approval."""
        current_dt_for_recruiter = self._format_datetime(current_start_time, recruiter_timezone)
        requested_dt_for_recruiter = self._format_datetime(requested_start_time, recruiter_timezone)
        requested_dt_for_candidate = self._format_datetime(requested_start_time, candidate_timezone)

        reason_block = ""
        if str(reason or "").strip():
            reason_block = f"<p><strong>Candidate note:</strong> {str(reason).strip()}</p>"

        recruiter_html = (
            "<p>Hello {name},</p>"
            "<p><strong>{candidate_name}</strong> requested to change interview time for <strong>{job_title}</strong>.</p>"
            "<ul>"
            "<li>Current slot: {current_date} at {current_time} ({current_tz})</li>"
            "<li>Requested slot: {requested_date} at {requested_time} ({requested_tz})</li>"
            "<li>Duration: {duration} minutes</li>"
            "</ul>"
            "{reason_block}"
            "<p>Please choose an action:</p>"
            "<p><a href=\"{approve_link}\">Approve reschedule</a></p>"
            "<p><a href=\"{decline_link}\">Decline request</a></p>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            job_title=job_info.get("title", "Position"),
            current_date=current_dt_for_recruiter["date"],
            current_time=current_dt_for_recruiter["time"],
            current_tz=current_dt_for_recruiter["timezone"],
            requested_date=requested_dt_for_recruiter["date"],
            requested_time=requested_dt_for_recruiter["time"],
            requested_tz=requested_dt_for_recruiter["timezone"],
            duration=duration_minutes,
            reason_block=reason_block,
            approve_link=approve_link,
            decline_link=decline_link,
        )

        recruiter_text = (
            f"{candidate.get('name', 'Candidate')} requested a reschedule for {job_info.get('title', 'Position')}. "
            f"Current: {current_dt_for_recruiter['date']} {current_dt_for_recruiter['time']} ({current_dt_for_recruiter['timezone']}). "
            f"Requested: {requested_dt_for_recruiter['date']} {requested_dt_for_recruiter['time']} ({requested_dt_for_recruiter['timezone']}). "
            f"Approve: {approve_link} | Decline: {decline_link}"
        )

        recruiter_result = await self.send_email_batch(
            recipients=[recruiter.get("email", "")],
            subject=f"Approval needed: Candidate reschedule request - {candidate.get('name', 'Candidate')}",
            html_content=recruiter_html,
            text_content=recruiter_text,
        )

        candidate_html = (
            "<p>Hello {name},</p>"
            "<p>Your request to change interview time for <strong>{job_title}</strong> was sent to the recruiter.</p>"
            "<p>Requested slot: {date} at {time} ({timezone})</p>"
            "<p>We will notify you once the recruiter approves or declines your request.</p>"
        ).format(
            name=candidate.get("name", "Candidate"),
            job_title=job_info.get("title", "Position"),
            date=requested_dt_for_candidate["date"],
            time=requested_dt_for_candidate["time"],
            timezone=requested_dt_for_candidate["timezone"],
        )

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Reschedule request sent - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content="Your reschedule request was sent to the recruiter and is pending approval.",
        )

        return {
            "success": recruiter_result["success"] and candidate_result["success"],
            "candidate": candidate_result,
            "recruiter": recruiter_result,
        }

    async def send_candidate_reschedule_declined_notification(
        self,
        candidate: Dict[str, Any],
        recruiter: Dict[str, Any],
        job_info: Dict[str, Any],
        requested_start_time: datetime,
        candidate_timezone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Notify candidate when recruiter declines a reschedule request."""
        requested_dt = self._format_datetime(requested_start_time, candidate_timezone)

        candidate_html = (
            "<p>Hello {name},</p>"
            "<p>Your request to change the interview time for <strong>{job_title}</strong> was declined by {recruiter_name}.</p>"
            "<p>Requested slot: {date} at {time} ({timezone})</p>"
            "<p>Your currently confirmed slot remains unchanged. You can request another slot from your scheduling page.</p>"
        ).format(
            name=candidate.get("name", "Candidate"),
            job_title=job_info.get("title", "Position"),
            recruiter_name=recruiter.get("name", "Recruiter"),
            date=requested_dt["date"],
            time=requested_dt["time"],
            timezone=requested_dt["timezone"],
        )

        candidate_result = await self.send_email_batch(
            recipients=[candidate.get("email", "")],
            subject=f"Reschedule request declined - {job_info.get('title', 'Position')}",
            html_content=candidate_html,
            text_content="Your requested reschedule was declined. Your current confirmed interview time remains active.",
        )

        return {
            "success": candidate_result["success"],
            "candidate": candidate_result,
        }


def create_email_service(settings: Settings, template_service: TemplateService) -> EmailService:
    """Factory for email service."""
    return EmailService(settings=settings, template_service=template_service)
