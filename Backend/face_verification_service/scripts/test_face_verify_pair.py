#!/usr/bin/env python
"""Manual 1:1 face verification smoke test.

Example:
  python scripts/test_face_verify_pair.py --profile path/to/candidate.jpg --live path/to/friend.jpg --expect not_matched
"""

import argparse
import base64
import mimetypes
import sys
from pathlib import Path

import requests


def image_to_data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{payload}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify one profile image against one live image.")
    parser.add_argument("--profile", required=True, help="Candidate profile photo path")
    parser.add_argument("--live", required=True, help="Live camera/friend photo path")
    parser.add_argument("--service-url", default="http://localhost:8011", help="Face service base URL")
    parser.add_argument("--threshold", type=float, default=0.60, help="Cosine similarity threshold")
    parser.add_argument("--required-frames", type=int, default=3, help="Frames sent to /face/verify")
    parser.add_argument("--min-matching-frames", type=int, default=2, help="Frames that must pass")
    parser.add_argument("--expect", choices=["matched", "not_matched", "uncertain", "failed"], default=None)
    args = parser.parse_args()

    profile_path = Path(args.profile)
    live_path = Path(args.live)
    if not profile_path.exists():
        print(f"profile image not found: {profile_path}", file=sys.stderr)
        return 2
    if not live_path.exists():
        print(f"live image not found: {live_path}", file=sys.stderr)
        return 2

    base_url = args.service_url.rstrip("/")
    profile_data = image_to_data_uri(profile_path)
    live_data = image_to_data_uri(live_path)

    enroll = requests.post(
        f"{base_url}/face/enroll",
        json={"imageBase64": profile_data},
        timeout=10,
    )
    enroll.raise_for_status()
    enroll_data = enroll.json()
    if not enroll_data.get("enrolled") or not enroll_data.get("embedding"):
        print("enrollment failed:", enroll_data)
        return 1

    verify = requests.post(
        f"{base_url}/face/verify",
        json={
            "profileEmbedding": enroll_data["embedding"],
            "liveFrames": [live_data] * args.required_frames,
            "threshold": args.threshold,
            "requiredFrames": args.required_frames,
            "minMatchingFrames": args.min_matching_frames,
        },
        timeout=10,
    )
    verify.raise_for_status()
    result = verify.json()

    print(f"status={result.get('status')}")
    print(f"allowInterview={result.get('allowInterview')}")
    print(f"verified={result.get('verified')}")
    print(f"metric={result.get('metric')}")
    print(f"similarity={result.get('similarity')}")
    print(f"medianSimilarity={result.get('medianSimilarity')}")
    print(f"bestSimilarity={result.get('bestSimilarity')}")
    print(f"threshold={result.get('threshold')}")
    print(f"matchingFrames={result.get('matchingFrames')}/{result.get('totalFrames')}")
    if result.get("reason"):
        print(f"reason={result.get('reason')}")

    if args.expect and result.get("status") != args.expect:
        print(f"expected status={args.expect}, got {result.get('status')}", file=sys.stderr)
        return 1

    if result.get("status") != "matched" and result.get("allowInterview") is True:
        print("failure: non-matched result allowed interview", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
