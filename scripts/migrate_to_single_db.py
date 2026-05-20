"""
migrate_to_single_db.py
Safely consolidates users, ai_recruiter_db, and ai_recruiter_platform
into a single "ai_recruiter" database.
Run ONCE. Safe to re-run (uses upsert on _id).
Does NOT delete source databases until you manually confirm.
"""
import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime

MONGO_URL = "mongodb://localhost:27017"
TARGET_DB  = "ai_recruiter"

# All source databases and their collections to migrate
SOURCES = {
    "users": [
        "applications", "callrooms", "candidatequizzes",
        "comparisonreports", "interview_final_reports",
        "interviews", "jobinterviewrooms", "jobs",
        "messages", "quizresults",
    ],
    "ai_recruiter_db": [
        "applications", "callrooms", "comparisonreports",
        "interview_final_reports", "interview_schedules",
        "interviews", "jobinterviewrooms", "jobs",
        "schedule_logs", "scheduling_side_effect_retries", "users",
    ],
    "ai_recruiter_platform": [
        "interview_audit_logs",
        "interview_behavioral_audit_logs",
        "interview_behavioral_events",
        "interview_behavioral_timeline_audit",
    ],
}


async def migrate():
    client = AsyncIOMotorClient(MONGO_URL)
    target = client[TARGET_DB]

    total_migrated = 0
    total_overwrites = 0
    report = {}

    print(f"\n{'='*55}")
    print(f"  MIGRATION START -> target: '{TARGET_DB}'")
    print(f"  {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print(f"{'='*55}\n")

    for source_db_name, collections in SOURCES.items():
        source = client[source_db_name]
        report[source_db_name] = {}

        for col_name in collections:
            source_col = source[col_name]
            target_col = target[col_name]

            source_count = await source_col.count_documents({})
            if source_count == 0:
                print(f"  [{source_db_name}] {col_name}: empty, skipping")
                continue

            # Pre-count target for overwrite detection
            target_before = await target_col.count_documents({})

            docs = await source_col.find({}).to_list(length=None)

            migrated = 0
            errors   = 0
            overwrites = 0
            for doc in docs:
                try:
                    existing = await target_col.find_one(
                        {"_id": doc["_id"]}, projection={"_id": 1}
                    )
                    if existing is not None:
                        overwrites += 1
                    await target_col.replace_one(
                        {"_id": doc["_id"]},
                        doc,
                        upsert=True,
                    )
                    migrated += 1
                except Exception as e:
                    errors += 1
                    print(f"    ERROR on {col_name} doc {doc['_id']}: {e}")

            target_count = await target_col.count_documents({})
            report[source_db_name][col_name] = {
                "source": source_count,
                "migrated": migrated,
                "errors": errors,
                "overwrites": overwrites,
                "target_before": target_before,
                "target_after": target_count,
            }
            total_migrated += migrated
            total_overwrites += overwrites
            status = "OK" if errors == 0 else "WARN"
            extra = f", {overwrites} overwrote existing _ids" if overwrites else ""
            print(
                f"  [{status}] [{source_db_name}] {col_name}: "
                f"{migrated}/{source_count} docs -> "
                f"target now has {target_count} docs{extra}"
            )

    print(f"\n{'='*55}")
    print(f"  MIGRATION COMPLETE")
    print(f"  Total documents migrated: {total_migrated}")
    print(f"  Total overwrites by later sources: {total_overwrites}")
    print(f"  Target database: '{TARGET_DB}'")
    print(f"\n  Source databases NOT deleted -- verify data")
    print(f"  then delete manually in MongoDB Compass.")
    print(f"{'='*55}\n")

    target_collections = await target.list_collection_names()
    print("Collections now in 'ai_recruiter':")
    for col in sorted(target_collections):
        count = await target[col].count_documents({})
        print(f"  {col}: {count} documents")

    client.close()


if __name__ == "__main__":
    asyncio.run(migrate())
