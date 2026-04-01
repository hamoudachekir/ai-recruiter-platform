import asyncio
import logging
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any, Dict, List, Optional

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

    @staticmethod
    def _format_datetime(value: datetime) -> Dict[str, str]:
        return {
            "date": value.strftime("%A, %B %d, %Y"),
            "time": value.strftime("%H:%M"),
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
    ) -> Dict[str, Any]:
        candidate_dt = self._format_datetime(start_time)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "interview_type": interview_type,
            "interview_mode": interview_mode,
            "interview_date": candidate_dt["date"],
            "interview_time": candidate_dt["time"],
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
            "confirmation_link": self.settings.frontend_confirmation_url,
            "company_name": self.settings.email_from_name,
        }

        candidate_html = self.template_service.render("interview_invitation.html", candidate_context)

        candidate_subject = f"Interview Invitation - {job_info.get('title', 'Position')}"
        candidate_text = (
            f"Your interview is scheduled on {candidate_dt['date']} at {candidate_dt['time']}."
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
            "<li>Duration: {duration} minutes</li>"
            "<li>Meeting Link: {meeting_link}</li>"
            "</ul>"
            "<p>Please check your calendar for the event details.</p>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            job_title=job_info.get("title", "Position"),
            date=candidate_dt["date"],
            time=candidate_dt["time"],
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
    ) -> Dict[str, Any]:
        old_dt = self._format_datetime(old_start_time)
        new_dt = self._format_datetime(new_start_time)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "old_interview_date": old_dt["date"],
            "old_interview_time": old_dt["time"],
            "new_interview_date": new_dt["date"],
            "new_interview_time": new_dt["time"],
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
            "<li>Reason: {reason}</li>"
            "</ul>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            old_date=old_dt["date"],
            old_time=old_dt["time"],
            new_date=new_dt["date"],
            new_time=new_dt["time"],
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
    ) -> Dict[str, Any]:
        slot_dt = self._format_datetime(start_time)

        candidate_context = {
            "candidate_name": candidate.get("name", "Candidate"),
            "job_title": job_info.get("title", "Position"),
            "interview_date": slot_dt["date"],
            "interview_time": slot_dt["time"],
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
            "<li>Reason: {reason}</li>"
            "</ul>"
        ).format(
            name=recruiter.get("name", "Recruiter"),
            candidate_name=candidate.get("name", "Candidate"),
            date=slot_dt["date"],
            time=slot_dt["time"],
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


def create_email_service(settings: Settings, template_service: TemplateService) -> EmailService:
    """Factory for email service."""
    return EmailService(settings=settings, template_service=template_service)
