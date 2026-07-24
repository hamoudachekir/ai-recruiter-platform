import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.schema import ApplicationRecord, ApplicationUpdate, FitAnalysis


DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "job_copilot.sqlite3"


def _db_path() -> Path:
    return Path(os.getenv("CV_COPILOT_DB", str(DEFAULT_DB_PATH)))


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            candidate_id TEXT NOT NULL,
            job_title TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            source_url TEXT NOT NULL DEFAULT '',
            job_text TEXT NOT NULL,
            score INTEGER NOT NULL,
            recommendation TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'discovered',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    return connection


def _to_record(row: sqlite3.Row) -> ApplicationRecord:
    return ApplicationRecord.model_validate(dict(row))


def save_analysis(
    candidate_id: str,
    job_text: str,
    analysis: FitAnalysis,
    job_title: str = "",
    company: str = "",
    source_url: str = "",
) -> ApplicationRecord:
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO applications (
                candidate_id, job_title, company, source_url, job_text,
                score, recommendation, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
            """,
            (
                candidate_id,
                job_title.strip(),
                company.strip(),
                source_url.strip(),
                job_text.strip(),
                analysis.score,
                analysis.recommendation,
                now,
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM applications WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return _to_record(row)


def list_applications(candidate_id: str) -> list[ApplicationRecord]:
    with _connect() as connection:
        rows = connection.execute(
            "SELECT * FROM applications WHERE candidate_id = ? ORDER BY updated_at DESC",
            (candidate_id,),
        ).fetchall()
    return [_to_record(row) for row in rows]


def update_application(
    application_id: int,
    candidate_id: str,
    update: ApplicationUpdate,
) -> ApplicationRecord | None:
    changes = update.model_dump(exclude_none=True)
    if not changes:
        with _connect() as connection:
            row = connection.execute(
                "SELECT * FROM applications WHERE id = ? AND candidate_id = ?",
                (application_id, candidate_id),
            ).fetchone()
        return _to_record(row) if row else None

    assignments = [f"{field} = ?" for field in changes]
    values = list(changes.values())
    assignments.append("updated_at = ?")
    values.append(datetime.now(timezone.utc).isoformat())
    values.extend([application_id, candidate_id])

    with _connect() as connection:
        connection.execute(
            f"UPDATE applications SET {', '.join(assignments)} WHERE id = ? AND candidate_id = ?",
            values,
        )
        row = connection.execute(
            "SELECT * FROM applications WHERE id = ? AND candidate_id = ?",
            (application_id, candidate_id),
        ).fetchone()
    return _to_record(row) if row else None
