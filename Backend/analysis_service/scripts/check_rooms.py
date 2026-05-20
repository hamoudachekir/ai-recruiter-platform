"""Check rooms in ai_recruiter database."""
import sys
sys.path.insert(0, '.')

from app.db.mongo import _client

def main():
    users_db = _client["ai_recruiter"]
    call_rooms_col = users_db["callrooms"]

    print("All rooms in ai_recruiter database:")
    print("=" * 60)

    rooms = list(call_rooms_col.find({}, {
        '_id': 1,
        'roomId': 1,
        'candidate': 1,
        'job': 1,
        'status': 1
    }))

    print(f"Found {len(rooms)} rooms")

    for room in rooms:
        print(f"\n_id: {room.get('_id')}")
        print(f"roomId: {room.get('roomId')}")
        print(f"candidate: {room.get('candidate')}")
        print(f"job: {room.get('job')}")
        print(f"status: {room.get('status')}")

        # Try to find the room we're looking for
        if room.get('roomId') == 'room-1777990314812-xjnv6zi7k':
            print("✅✅✅ FOUND TARGET ROOM ✅✅✅")

    print("\n" + "=" * 60)

    # Check if the roomId format is different
    test_ids = [
        'room-1777990314812-xjnv6zi7k',
        '1777990314812-xjnv6zi7k',
        'room-1777990314812',
    ]

    print("\nTesting different ID formats:")
    for test_id in test_ids:
        room = call_rooms_col.find_one({'roomId': test_id})
        if room:
            print(f"✅ Found with: {test_id}")
        else:
            print(f"❌ Not found: {test_id}")

if __name__ == "__main__":
    main()
