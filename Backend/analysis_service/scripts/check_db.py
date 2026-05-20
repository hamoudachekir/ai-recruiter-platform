"""Check MongoDB connection and list databases/collections."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import db, _client

def main():
    print(f"Connected to database: {db.name}")
    print(f"Collections in database: {db.list_collection_names()}")
    print("\nAll databases on server:")

    for db_name in _client.list_database_names():
        print(f"  - {db_name}")

    print("\n" + "=" * 60)

    # Try to count documents in callrooms
    try:
        count = db["callrooms"].count_documents({})
        print(f"Call rooms collection has {count} documents")

        if count > 0:
            print("\nSample room IDs:")
            for room in db["callrooms"].find({}, {'roomId': 1, '_id': 1}).limit(3):
                print(f"  _id: {room.get('_id')}")
                print(f"  roomId: {room.get('roomId')}")
    except Exception as e:
        print(f"Error accessing callrooms: {e}")

if __name__ == "__main__":
    main()
