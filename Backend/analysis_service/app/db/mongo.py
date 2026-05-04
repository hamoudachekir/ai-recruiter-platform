from pymongo import MongoClient

from app.core.config import MONGO_DB_NAME, MONGO_URL


_client = MongoClient(MONGO_URL)
db = _client[MONGO_DB_NAME]

jobs_col = db["video_analysis_jobs"]
vision_events_col = db["post_interview_vision_events"]
transcripts_col = db["interview_transcripts"]
reports_col = db["interview_final_reports"]
call_rooms_col = db["callrooms"]
