"""Find rooms in MongoDB to understand the ID format."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import db

def main():
    call_rooms_col = db["callrooms"]

    # List recent rooms
    print("Recent call rooms in database:")
    print("=" * 70)

    rooms = list(call_rooms_col.find({}, {
        '_id': 1,
        'roomId': 1,
        'candidate': 1,
        'job': 1,
        'status': 1
    }).limit(5))

    for room in rooms:
        print(f"\nRoom ID (_id): {room.get('_id')}")
        print(f"Room ID (roomId): {room.get('roomId')}")
        print(f"Candidate: {room.get('candidate')}")
        print(f"Job: {room.get('job')}")
        print(f"Status: {room.get('status')}")
        print("-" * 70)

    # Try to find the specific room
    test_id = 'room-1777990314812-xjnv6zi7k'
    print(f"\nSearching for room with ID: {test_id}")

    # Try by roomId
    by_room_id = call_rooms_col.find_one({'roomId': test_id})
    if by_room_id:
        print(f"✅ Found by roomId: {by_room_id.get('_id')}")
    else:
        print("❌ Not found by roomId")

    # Try by _id (ObjectId)
    from bson.objectid import ObjectId
    try:
        oid = ObjectId(test_id)
        by_oid = call_rooms_col.find_one({'_id': oid})
        if by_oid:
            print(f"✅ Found by _id: {by_oid.get('roomId')}")
        else:
            print("❌ Not found by _id")
    except:
        print("⚠️ ID is not valid ObjectId format")

    # Try by interviewId
    by_interview = call_rooms_col.find_one({'interviewId': test_id})
    if by_interview:
        print(f"✅ Found by interviewId: {by_interview.get('_id')}")
    else:
        print("❌ Not found by interviewId")

    print("\n" + "=" * 70)

if __name__ == "__main__":
    main()
