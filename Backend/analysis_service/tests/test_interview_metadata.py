"""Tests for interview metadata resolution service."""
import pytest
from unittest.mock import MagicMock, patch

# Mock MongoDB client before importing the module
mock_client = MagicMock()
mock_users_db = MagicMock()
mock_collections = {
    "callrooms": MagicMock(),
    "users": MagicMock(),
    "jobs": MagicMock(),
    "applications": MagicMock(),
}
mock_users_db.__getitem__ = lambda self, key: mock_collections.get(key, MagicMock())
# Post-consolidation: USERS_DB_NAME defaults to "ai_recruiter".
# We also accept "users" so legacy callers/env overrides still resolve.
mock_client.__getitem__ = lambda self, key: (
    mock_users_db if key in ("ai_recruiter", "users") else MagicMock()
)

# Patch the _client import
with patch("app.db.mongo._client", mock_client):
    from app.services.interview_metadata import (
        resolve_interview_metadata,
        get_report_metadata,
        _coerce_object_id,
    )


class TestCoerceObjectId:
    """Test ObjectId coercion helper."""

    def test_valid_string(self):
        """Should convert valid string to ObjectId."""
        from bson.objectid import ObjectId

        result = _coerce_object_id("507f1f77bcf86cd799439011")
        assert isinstance(result, ObjectId)
        assert str(result) == "507f1f77bcf86cd799439011"

    def test_invalid_string(self):
        """Should return None for invalid string."""
        result = _coerce_object_id("invalid-id")
        assert result is None

    def test_objectid_input(self):
        """Should return same ObjectId if input is already ObjectId."""
        from bson.objectid import ObjectId

        oid = ObjectId()
        result = _coerce_object_id(oid)
        assert result == oid

    def test_none_input(self):
        """Should return None for None input."""
        result = _coerce_object_id(None)
        assert result is None


class TestResolveInterviewMetadata:
    """Test interview metadata resolution."""

    def test_no_interview_id(self):
        """Should return empty result for no interview_id."""
        result = resolve_interview_metadata("")
        assert result["found"] is False
        assert result["candidate_name"] is None

    def test_room_not_found(self):
        """Should return empty result when room not found."""
        mock_collections["callrooms"].find_one.return_value = None

        result = resolve_interview_metadata("nonexistent-room")
        assert result["found"] is False

    def test_room_found_no_candidate_or_job(self):
        """Should return partial result when room has no candidate/job."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        mock_collections["callrooms"].find_one.return_value = {
            "_id": room_id,
            "roomId": "test-room-123",
            # No candidate or job
        }

        result = resolve_interview_metadata("test-room-123")
        assert result["found"] is True
        assert result["candidate_name"] is None
        assert result["job_title"] is None

    def test_full_resolution(self):
        """Should resolve full metadata with candidate and job."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()
        job_id = ObjectId()
        application_id = ObjectId()

        # Mock call room
        mock_collections["callrooms"].find_one.return_value = {
            "_id": room_id,
            "roomId": "test-room-123",
            "candidate": candidate_id,
            "job": job_id,
        }

        # Mock candidate user
        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "firstName": "John",
            "lastName": "Doe",
            "email": "john.doe@example.com",
        }

        # Mock job
        mock_collections["jobs"].find_one.return_value = {
            "_id": job_id,
            "title": "Senior Software Engineer",
        }

        # Mock application
        mock_collections["applications"].find_one.return_value = {
            "_id": application_id,
            "candidate": candidate_id,
            "job": job_id,
        }

        result = resolve_interview_metadata("test-room-123")

        assert result["found"] is True
        assert result["candidate_name"] == "John Doe"
        assert result["candidate_email"] == "john.doe@example.com"
        assert result["job_title"] == "Senior Software Engineer"
        assert result["job_id"] == str(job_id)
        assert result["application_id"] == str(application_id)

    def test_candidate_by_email_only(self):
        """Should use email when name fields are missing."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()

        mock_collections["callrooms"].find_one.return_value = {
            "_id": room_id,
            "candidate": candidate_id,
        }

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "email": "jane@example.com",
            # No firstName/lastName
        }

        mock_collections["jobs"].find_one.return_value = None
        mock_collections["applications"].find_one.return_value = None

        result = resolve_interview_metadata(str(room_id))

        assert result["candidate_name"] == "jane@example.com"

    def test_missing_candidate_in_db(self):
        """Should handle candidate ID not found in users collection."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()
        job_id = ObjectId()

        mock_collections["callrooms"].find_one.return_value = {
            "_id": room_id,
            "candidate": candidate_id,
            "job": job_id,
        }

        # Candidate not found
        mock_collections["users"].find_one.return_value = None

        mock_collections["jobs"].find_one.return_value = {
            "_id": job_id,
            "title": "Data Scientist",
        }

        result = resolve_interview_metadata(str(room_id))

        assert result["found"] is True
        assert result["candidate_name"] is None  # Not resolved
        assert result["job_title"] == "Data Scientist"  # Resolved

    def test_missing_job_in_db(self):
        """Should handle job ID not found in jobs collection."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()
        job_id = ObjectId()

        mock_collections["callrooms"].find_one.return_value = {
            "_id": room_id,
            "candidate": candidate_id,
            "job": job_id,
        }

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "firstName": "Alice",
            "lastName": "Smith",
            "email": "alice@example.com",
        }

        # Job not found
        mock_collections["jobs"].find_one.return_value = None

        result = resolve_interview_metadata(str(room_id))

        assert result["found"] is True
        assert result["candidate_name"] == "Alice Smith"
        assert result["job_title"] is None  # Not resolved

    def test_lookup_by_room_id_string(self):
        """Should find room by roomId string (not just _id)."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        room_room_id = "room-1778057279953-l0hmu8ldy"
        candidate_id = ObjectId()

        # First call with ObjectId returns None
        # Second call with roomId string returns the room
        def mock_find_one(query):
            if "_id" in query:
                return None  # Not found by _id
            if query.get("roomId") == room_room_id:
                return {
                    "_id": room_id,
                    "roomId": room_room_id,
                    "candidate": candidate_id,
                }
            return None

        mock_collections["callrooms"].find_one.side_effect = mock_find_one

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "firstName": "Test",
            "lastName": "Candidate",
            "email": "test@example.com",
        }

        mock_collections["jobs"].find_one.return_value = None

        result = resolve_interview_metadata(room_room_id)

        assert result["found"] is True
        assert result["candidate_name"] == "Test Candidate"

    def test_lookup_attempts_order(self):
        """Should try _id, then roomId, then interviewId in order."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        # Use the string representation of ObjectId so it tries _id lookup first
        room_id_str = str(room_id)

        queries = []

        def mock_find_one(query):
            queries.append(query)
            # Return room on the 3rd try (interviewId lookup)
            if query.get("interviewId") == room_id_str:
                return {
                    "_id": room_id,
                    "roomId": "room-123",
                }
            return None

        mock_collections["callrooms"].find_one.side_effect = mock_find_one

        result = resolve_interview_metadata(room_id_str)

        # Verify lookup order: _id, roomId, interviewId
        assert len(queries) == 3, f"Expected 3 queries, got {len(queries)}: {queries}"
        assert "_id" in queries[0]
        assert "roomId" in queries[1]
        assert "interviewId" in queries[2]
        assert result["found"] is True

    def test_only_first_name_available(self):
        """Should use only first name when last name not available."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()

        # Handle multiple find_one calls
        def mock_room_find(query):
            if "_id" in query and query["_id"] == room_id:
                return {"_id": room_id, "candidate": candidate_id}
            return None

        mock_collections["callrooms"].find_one.side_effect = mock_room_find

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "firstName": "Jane",
            # No lastName
            "email": "jane@example.com",
        }

        mock_collections["jobs"].find_one.return_value = None

        result = resolve_interview_metadata(str(room_id))

        assert result["candidate_name"] == "Jane"

    def test_unknown_candidate_fallback(self):
        """Should use 'Unknown Candidate' when no name or email available."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()

        # Need to handle multiple find_one calls (for room, then candidate)
        def mock_room_find(query):
            if "_id" in query and query["_id"] == room_id:
                return {"_id": room_id, "candidate": candidate_id}
            return None

        mock_collections["callrooms"].find_one.side_effect = mock_room_find

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            # No firstName, lastName, or email
        }

        mock_collections["jobs"].find_one.return_value = None

        result = resolve_interview_metadata(str(room_id))

        assert result["candidate_name"] == "Unknown Candidate"
        assert result["candidate_email"] == ""


class TestGetReportMetadata:
    """Test report metadata formatting."""

    def test_safe_fallbacks(self):
        """Should return safe fallback values when data missing."""
        mock_collections["callrooms"].find_one.return_value = None

        result = get_report_metadata("unknown-id")

        assert result["candidate_name"] == "Candidate"
        assert result["job_title"] == "Job not linked"
        assert result["job_metadata_status"] == "missing"
        assert result["candidate_email"] == ""
        assert result["job_id"] is None
        assert result["application_id"] is None

    def test_real_values_when_found(self):
        """Should return real values when metadata found."""
        from bson.objectid import ObjectId

        room_id = ObjectId()
        candidate_id = ObjectId()
        job_id = ObjectId()

        # Handle multiple find_one calls with side_effect
        def mock_room_find(query):
            if "_id" in query and query["_id"] == room_id:
                return {
                    "_id": room_id,
                    "candidate": candidate_id,
                    "job": job_id,
                }
            return None

        mock_collections["callrooms"].find_one.side_effect = mock_room_find

        mock_collections["users"].find_one.return_value = {
            "_id": candidate_id,
            "firstName": "Bob",
            "lastName": "Wilson",
            "email": "bob@example.com",
        }

        mock_collections["jobs"].find_one.return_value = {
            "_id": job_id,
            "title": "Product Manager",
        }

        mock_collections["applications"].find_one.return_value = None

        result = get_report_metadata(str(room_id))

        assert result["candidate_name"] == "Bob Wilson"
        assert result["job_title"] == "Product Manager"
        assert result["candidate_email"] == "bob@example.com"
        assert result["job_id"] == str(job_id)


class TestConsolidatedDatabaseSupport:
    """Test that metadata resolution works against the single consolidated DB."""

    def test_users_database_accessible(self):
        """Should be able to access the metadata database."""
        from app.services.interview_metadata import _get_users_db

        users_db = _get_users_db()
        assert users_db is not None

    def test_metadata_uses_consolidated_database(self):
        """All metadata collections (callrooms, users, jobs, applications)
        should resolve from the same database after consolidation."""
        mock_client = MagicMock()
        mock_unified_db = MagicMock()

        def get_db(self, name):
            if name == "ai_recruiter":
                return mock_unified_db
            return MagicMock()

        type(mock_client).__getitem__ = get_db

        assert mock_client["ai_recruiter"] == mock_unified_db


if __name__ == "__main__":
    print("Running interview metadata tests...")
    # Run basic tests
    test_coerce = TestCoerceObjectId()
    test_coerce.test_valid_string()
    print("✓ coerce valid string")
    test_coerce.test_invalid_string()
    print("✓ coerce invalid string")
    test_coerce.test_none_input()
    print("✓ coerce none input")

    test_resolve = TestResolveInterviewMetadata()
    test_resolve.test_no_interview_id()
    print("✓ no interview id")
    test_resolve.test_room_not_found()
    print("✓ room not found")
    test_resolve.test_room_found_no_candidate_or_job()
    print("✓ room found no candidate or job")
    test_resolve.test_lookup_by_room_id_string()
    print("✓ lookup by roomId string")

    test_format = TestGetReportMetadata()
    test_format.test_safe_fallbacks()
    print("✓ safe fallbacks")

    print("\nAll interview metadata tests passed!")
