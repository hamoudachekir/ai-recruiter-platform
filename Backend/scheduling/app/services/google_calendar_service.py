import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)


class GoogleCalendarServiceError(Exception):
    """Raised when Google Calendar operations fail."""


class GoogleCalendarService:
    """Thin wrapper around Google Calendar API operations."""

    def __init__(self, default_calendar_id: str = "primary", timezone: str = "UTC"):
        self.default_calendar_id = default_calendar_id
        self.timezone = timezone

    def _build_client(self, access_token: str):
        if not access_token:
            raise GoogleCalendarServiceError("Missing Google access token")

        credentials = Credentials(token=access_token)
        return build("calendar", "v3", credentials=credentials, cache_discovery=False)

    @staticmethod
    def _parse_google_datetime(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo:
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed

    def get_busy_slots(
        self,
        access_token: str,
        start_time: datetime,
        end_time: datetime,
        calendar_id: Optional[str] = None,
    ) -> List[Tuple[datetime, datetime]]:
        """Return busy windows from Google Calendar free/busy API."""
        calendar = calendar_id or self.default_calendar_id

        try:
            service = self._build_client(access_token)
            body = {
                "timeMin": start_time.isoformat(),
                "timeMax": end_time.isoformat(),
                "timeZone": self.timezone,
                "items": [{"id": calendar}],
            }

            response = service.freebusy().query(body=body).execute()
            busy_items = (
                response.get("calendars", {})
                .get(calendar, {})
                .get("busy", [])
            )

            busy_slots: List[Tuple[datetime, datetime]] = []
            for item in busy_items:
                busy_start = self._parse_google_datetime(item.get("start"))
                busy_end = self._parse_google_datetime(item.get("end"))
                if busy_start and busy_end:
                    busy_slots.append((busy_start, busy_end))

            return busy_slots

        except HttpError as exc:
            logger.error("Google busy slots API failed: %s", str(exc))
            raise GoogleCalendarServiceError("Failed to fetch busy slots") from exc
        except Exception as exc:
            logger.error("Unexpected busy slots error: %s", str(exc))
            raise GoogleCalendarServiceError("Unexpected busy slots error") from exc

    def create_event(
        self,
        access_token: str,
        summary: str,
        description: str,
        start_time: datetime,
        end_time: datetime,
        attendee_emails: List[str],
        location: Optional[str] = None,
        create_meet_link: bool = True,
        calendar_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a calendar event and optionally a Google Meet link."""
        calendar = calendar_id or self.default_calendar_id

        try:
            service = self._build_client(access_token)
            attendees = [{"email": email} for email in attendee_emails if email]

            body: Dict[str, Any] = {
                "summary": summary,
                "description": description,
                "start": {
                    "dateTime": start_time.isoformat(),
                    "timeZone": self.timezone,
                },
                "end": {
                    "dateTime": end_time.isoformat(),
                    "timeZone": self.timezone,
                },
                "attendees": attendees,
            }

            if location:
                body["location"] = location

            if create_meet_link:
                body["conferenceData"] = {
                    "createRequest": {
                        "requestId": str(uuid4()),
                        "conferenceSolutionKey": {"type": "hangoutsMeet"},
                    }
                }

            request = service.events().insert(
                calendarId=calendar,
                body=body,
                sendUpdates="all",
                conferenceDataVersion=1 if create_meet_link else 0,
            )
            event = request.execute()

            return {
                "id": event.get("id"),
                "html_link": event.get("htmlLink"),
                "meeting_link": event.get("hangoutLink"),
            }

        except HttpError as exc:
            logger.error("Google create event failed: %s", str(exc))
            raise GoogleCalendarServiceError("Failed to create calendar event") from exc
        except Exception as exc:
            logger.error("Unexpected create event error: %s", str(exc))
            raise GoogleCalendarServiceError("Unexpected create event error") from exc

    def update_event(
        self,
        access_token: str,
        event_id: str,
        summary: str,
        description: str,
        start_time: datetime,
        end_time: datetime,
        attendee_emails: List[str],
        location: Optional[str] = None,
        calendar_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update an existing calendar event."""
        calendar = calendar_id or self.default_calendar_id

        try:
            service = self._build_client(access_token)
            event = service.events().get(calendarId=calendar, eventId=event_id).execute()

            event["summary"] = summary
            event["description"] = description
            event["start"] = {
                "dateTime": start_time.isoformat(),
                "timeZone": self.timezone,
            }
            event["end"] = {
                "dateTime": end_time.isoformat(),
                "timeZone": self.timezone,
            }
            event["attendees"] = [{"email": email} for email in attendee_emails if email]

            if location:
                event["location"] = location

            updated = service.events().update(
                calendarId=calendar,
                eventId=event_id,
                body=event,
                sendUpdates="all",
                conferenceDataVersion=1,
            ).execute()

            return {
                "id": updated.get("id"),
                "html_link": updated.get("htmlLink"),
                "meeting_link": updated.get("hangoutLink"),
            }

        except HttpError as exc:
            logger.error("Google update event failed: %s", str(exc))
            raise GoogleCalendarServiceError("Failed to update calendar event") from exc
        except Exception as exc:
            logger.error("Unexpected update event error: %s", str(exc))
            raise GoogleCalendarServiceError("Unexpected update event error") from exc

    def cancel_event(
        self,
        access_token: str,
        event_id: str,
        calendar_id: Optional[str] = None,
    ) -> None:
        """Cancel/delete an existing calendar event."""
        calendar = calendar_id or self.default_calendar_id

        try:
            service = self._build_client(access_token)
            service.events().delete(
                calendarId=calendar,
                eventId=event_id,
                sendUpdates="all",
            ).execute()

        except HttpError as exc:
            logger.error("Google cancel event failed: %s", str(exc))
            raise GoogleCalendarServiceError("Failed to cancel calendar event") from exc
        except Exception as exc:
            logger.error("Unexpected cancel event error: %s", str(exc))
            raise GoogleCalendarServiceError("Unexpected cancel event error") from exc


def create_google_calendar_service(default_calendar_id: str, timezone: str) -> GoogleCalendarService:
    """Factory for Google calendar service."""
    return GoogleCalendarService(default_calendar_id=default_calendar_id, timezone=timezone)
