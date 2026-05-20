"""Find which database contains the callrooms collection."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import _client

def main():
    # Check each database for callrooms collection
    db_names = ['ai_recruiter', 'test']

    for db_name in db_names:
        db = _client[db_name]
        collections = db.list_collection_names()

        if 'callrooms' in collections:
            print(f"✅ Found callrooms in database: {db_name}")

            # Count documents
            count = db['callrooms'].count_documents({})
            print(f"   Documents: {count}")

            if count > 0:
                print("\n   Sample rooms:")
                for room in db['callrooms'].find().limit(3):
                    print(f"     _id: {room.get('_id')}")
                    if room.get('roomId'):
                        print(f"     roomId: {room.get('roomId')}")
                    if room.get('candidate'):
                        print(f"     candidate: {room.get('candidate')}")
                    if room.get('job'):
                        print(f"     job: {room.get('job')}")
                    print()
        else:
            print(f"❌ No callrooms in: {db_name}")

    print("\n" + "=" * 60)

if __name__ == "__main__":
    main()
