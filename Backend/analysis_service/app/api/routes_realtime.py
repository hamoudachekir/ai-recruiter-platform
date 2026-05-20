"""Realtime advisory analysis websocket routes — Phase 5."""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.websocket("/interview/{interview_id}/stream")
async def realtime_stream(websocket: WebSocket, interview_id: str):
    """Stream advisory interview analysis events.

    Protocol:
      Client JSON: {"type": "transcript.partial", "payload": {...}}
      Client bytes: raw audio chunk; advisory only.
      Server JSON: {"type": "realtime.snapshot", "metrics": {...}}
    """
    from app.monitoring.metrics import ACTIVE_REALTIME_SESSIONS, WEBSOCKET_DISCONNECTS
    from app.services.realtime_analysis_service import RealtimeAnalysisSession

    tenant_id = websocket.headers.get("X-Tenant-ID", "")
    org_id = websocket.headers.get("X-Organization-ID", "")
    await websocket.accept()

    session = RealtimeAnalysisSession(
        interview_id=interview_id,
        tenant_id=tenant_id,
        organization_id=org_id,
    )
    ACTIVE_REALTIME_SESSIONS.labels(tenant_id=tenant_id or "unknown").inc()

    await websocket.send_json(
        {
            "type": "realtime.connected",
            "sessionId": session.state.sessionId,
            "interviewId": interview_id,
            "advisoryOnly": True,
        }
    )

    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message and message["bytes"] is not None:
                response = session.handle_binary_audio(message["bytes"])
            elif "text" in message and message["text"] is not None:
                import json

                try:
                    event = json.loads(message["text"])
                except json.JSONDecodeError:
                    response = {
                        "type": "realtime.warning",
                        "sessionId": session.state.sessionId,
                        "message": "Invalid JSON event",
                    }
                else:
                    response = session.handle_event(event)
            else:
                response = {
                    "type": "realtime.warning",
                    "sessionId": session.state.sessionId,
                    "message": "Unsupported websocket frame",
                }
            await websocket.send_json(response)
    except WebSocketDisconnect:
        WEBSOCKET_DISCONNECTS.labels(
            tenant_id=tenant_id or "unknown", reason="client_disconnect"
        ).inc()
    except Exception:
        WEBSOCKET_DISCONNECTS.labels(
            tenant_id=tenant_id or "unknown", reason="server_error"
        ).inc()
        raise
    finally:
        ACTIVE_REALTIME_SESSIONS.labels(tenant_id=tenant_id or "unknown").dec()
        session.persist_final_session()
