import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.config import get_settings  # noqa: E402
from app.services.email_service import EmailService  # noqa: E402
from app.services.template_service import create_template_service  # noqa: E402


class TestFailure(Exception):
    pass


class DryRunEmailService(EmailService):
    def __init__(self, settings, template_service):
        super().__init__(settings, template_service)
        self.captured = []

    async def send_email_batch(self, recipients, subject, html_content, text_content=""):
        self.captured.append(
            {
                "recipients": recipients,
                "subject": subject,
                "html": html_content,
                "text": text_content,
            }
        )
        return {
            "provider": "dry-run",
            "success": True,
            "sent_to": recipients,
            "failed": [],
        }


def _request_json(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 60) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise TestFailure(f"HTTP {exc.code} on {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise TestFailure(f"Network error on {url}: {exc}") from exc


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise TestFailure(message)


def _parse_naive_utc(value: str) -> datetime:
    normalized = str(value).replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def run_scheduling_flow(args) -> dict:
    app_id = f"wf-email-time-{uuid.uuid4().hex[:8]}"

    start_payload = {
        "candidate_id": args.candidate_id,
        "recruiter_id": args.recruiter_id,
        "job_id": args.job_id,
        "application_id": app_id,
        "interview_type": "video",
        "interview_mode": "synchronous",
        "duration_minutes": 60,
    }

    start = _request_json(
        f"{args.scheduling_base_url}/api/scheduling/start",
        method="POST",
        payload=start_payload,
    )

    _assert(start.get("status") == "suggested_slots_ready", "Start did not return suggested_slots_ready")
    suggested_slots = start.get("suggested_slots") or []
    _assert(len(suggested_slots) > 0, "Start did not return suggested slots")

    selected_slot = suggested_slots[0]

    confirm_payload = {
        "interview_schedule_id": start["interview_schedule_id"],
        "selected_slot": {
            "start_time": selected_slot["start_time"],
            "end_time": selected_slot["end_time"],
        },
        "location": "Google Meet",
        "notes": "Automated scheduling+email-time test",
    }

    confirm = _request_json(
        f"{args.scheduling_base_url}/api/scheduling/confirm",
        method="POST",
        payload=confirm_payload,
    )

    _assert(confirm.get("status") == "confirmed", "Confirm did not return confirmed status")

    schedule_id = str(start["interview_schedule_id"])
    final = _request_json(f"{args.scheduling_base_url}/api/scheduling/{schedule_id}")

    _assert(final.get("status") == "confirmed", "Final schedule status is not confirmed")
    _assert(bool((final.get("confirmed_slot") or {}).get("start_time")), "Final confirmed slot missing start_time")

    return {
        "schedule_id": schedule_id,
        "start_status": start.get("status"),
        "confirm_status": confirm.get("status"),
        "final_status": final.get("status"),
        "email_status": final.get("email_status"),
        "confirmed_start": (final.get("confirmed_slot") or {}).get("start_time"),
    }


def check_reminder_offsets(args, schedule_id: str, confirmed_start: str) -> dict:
    client = MongoClient(args.mongo_url)
    db = client[args.mongo_db]

    logs = list(
        db.schedule_logs.find(
            {
                "interview_schedule_id": schedule_id,
                "action": "reminder_scheduled",
            }
        ).sort("created_at", -1)
    )

    client.close()

    _assert(len(logs) >= 2, "Expected at least 2 reminder_scheduled logs")

    start_dt = _parse_naive_utc(confirmed_start)
    offsets = {}

    for entry in logs:
        details = entry.get("details") or {}
        reminder_type = str(details.get("reminder_type") or "")
        run_at = details.get("run_at")
        if not reminder_type or not run_at:
            continue

        run_dt = _parse_naive_utc(str(run_at))
        diff_hours = (start_dt - run_dt).total_seconds() / 3600.0
        offsets[reminder_type] = round(diff_hours, 3)

    _assert("1h" in offsets, "Missing 1h reminder offset")
    _assert("24h" in offsets, "Missing 24h reminder offset")
    _assert(abs(offsets["1h"] - 1.0) < 0.01, f"1h reminder offset invalid: {offsets['1h']}")
    _assert(abs(offsets["24h"] - 24.0) < 0.01, f"24h reminder offset invalid: {offsets['24h']}")

    return {"offset_hours": offsets}


async def check_email_render_time(confirmed_start: str) -> dict:
    settings = get_settings()
    service = DryRunEmailService(settings, create_template_service())

    start_dt = _parse_naive_utc(confirmed_start)

    await service.send_interview_reminder_notifications(
        candidate={"name": "CONDIDAT", "email": "cand@example.com"},
        recruiter={"name": "Recruiter", "email": "rec@example.com"},
        job_info={"title": "Position"},
        start_time=start_dt,
        interview_mode="synchronous",
        location="Google Meet",
        meeting_link="https://meet.google.com/test-link",
        reminder_type="1h",
        candidate_timezone="UTC",
        recruiter_timezone="UTC",
    )

    expected_local_time = start_dt.replace(tzinfo=timezone.utc).astimezone().strftime("%H:%M")
    html_blob = "\n".join(item.get("html", "") for item in service.captured)

    _assert(expected_local_time in html_blob, "Rendered reminder HTML does not contain expected local time")
    _assert("Timezone:" in html_blob, "Rendered reminder HTML does not include timezone label")

    return {
        "expected_local_time": expected_local_time,
        "captured_messages": len(service.captured),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Scheduling + email timezone integration smoke test")
    parser.add_argument("--scheduling-base-url", default="http://localhost:5004")
    parser.add_argument("--candidate-id", default="69cb04ad8c22bc5de2283c88")
    parser.add_argument("--recruiter-id", default="69cb03a88c22bc5de2283c6f")
    parser.add_argument("--job-id", default="69cbe8ef21147a473d6ba165")
    parser.add_argument("--mongo-url", default="mongodb://localhost:27017")
    parser.add_argument("--mongo-db", default="ai_recruiter_db")
    args = parser.parse_args()

    report: dict = {
        "ok": False,
        "steps": {},
    }

    try:
        health = _request_json(f"{args.scheduling_base_url}/health")
        _assert(health.get("status") in ["healthy", "degraded"], "Scheduling health endpoint returned unexpected status")
        report["steps"]["health"] = health

        scheduling_result = run_scheduling_flow(args)
        report["steps"]["scheduling"] = scheduling_result

        reminder_result = check_reminder_offsets(
            args,
            schedule_id=scheduling_result["schedule_id"],
            confirmed_start=scheduling_result["confirmed_start"],
        )
        report["steps"]["reminders"] = reminder_result

        import asyncio

        render_result = asyncio.run(check_email_render_time(scheduling_result["confirmed_start"]))
        report["steps"]["email_render"] = render_result

        report["ok"] = True

    except Exception as exc:
        report["error"] = str(exc)

    print(json.dumps(report, indent=2))

    if not report.get("ok"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
