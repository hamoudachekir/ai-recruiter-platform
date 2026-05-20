import asyncio
import sys
sys.path.insert(0, 'Backend/analysis_service')

from dotenv import load_dotenv
load_dotenv('Backend/analysis_service/.env')

from app.db import get_db

async def check_interviews():
    db = await get_db()
    
    # Find interviews with video recordings
    pipeline = [
        {'$match': {'recordingUrl': {'$exists': True, '$ne': None}}},
        {'$sort': {'createdAt': -1}},
        {'$limit': 5}
    ]
    
    interviews = await db['call_rooms'].aggregate(pipeline).to_list(5)
    
    print('Found interviews with recordings:')
    for i in interviews:
        print(f"  - ID: {str(i.get('_id'))}")
        print(f"    Candidate: {i.get('candidateName', 'N/A')}")
        print(f"    Job ID: {i.get('jobId', 'Not linked')}")
        print(f"    Recording: {i.get('recordingUrl', 'N/A')[:50]}...")
        print(f"    Has transcript: {bool(i.get('transcript'))}")
        print()
    
    # Also check for completed transcripts
    transcripts = await db['transcripts'].find().sort('createdAt', -1).limit(3).to_list(3)
    print('\nRecent transcripts:')
    for t in transcripts:
        print(f"  - Interview ID: {t.get('interviewId')}")
        segments = t.get('segments', [])
        print(f"    Segments: {len(segments)}")
        full_text = t.get('fullText', '')
        print(f"    Has text: {bool(full_text and full_text.strip())}")
        if full_text:
            print(f"    Text preview: {full_text[:100]}...")
        print()
    
    # Count total
    total_interviews = await db['call_rooms'].count_documents({})
    total_with_recording = await db['call_rooms'].count_documents({'recordingUrl': {'$exists': True, '$ne': None}})
    print(f"\nTotal interviews: {total_interviews}")
    print(f"With recordings: {total_with_recording}")

if __name__ == '__main__':
    asyncio.run(check_interviews())
