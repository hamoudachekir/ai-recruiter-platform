"""List all databases and their collections."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import _client

def main():
    print("All databases on MongoDB server:")
    print("=" * 60)

    for db_name in _client.list_database_names():
        db = _client[db_name]
        collections = db.list_collection_names()

        print(f"\n📁 {db_name}")
        print(f"   Collections: {', '.join(collections) if collections else '(empty)'}")

        # Specifically look for callrooms
        if 'callrooms' in collections:
            print(f"   ✅ Contains callrooms!")
            count = db['callrooms'].count_documents({})
            print(f"   Documents: {count}")

            if count > 0:
                print("\n   Sample rooms:")
                for room in db['callrooms'].find().limit(2):
                    print(f"     _id: {room.get('_id')}")
                    if room.get('roomId'):
                        print(f"     roomId: {room.get('roomId')}")
                    print()

    print("\n" + "=" * 60)

if __name__ == "__main__":
    main()
