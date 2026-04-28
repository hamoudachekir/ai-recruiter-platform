import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, status
from fastapi.responses import HTMLResponse
from datetime import datetime

from app.schemas.scheduling import (
    StartSchedulingRequest,
    StartSchedulingResponse,
    ConfirmSlotRequest,
    ConfirmSlotResponse,
    CandidateTokenConfirmRequest,
    CandidateTokenDeclineRequest,
    CandidateTokenRescheduleRequest,
    RescheduleRequest,
    RescheduleResponse,
    CancelRequest,
    CancelResponse,
    PublicScheduleResponse,
    AlternativeSlotsResponse,
    CandidateDeclineResponse,
    ErrorResponse,
    InterviewScheduleResponse
)
from app.services.scheduling_orchestrator import SchedulingOrchestrator, SchedulingConflictError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scheduling", tags=["scheduling"])


# Dependency injection for orchestrator
def get_orchestrator() -> SchedulingOrchestrator:
    """Get orchestrator instance - will be provided by FastAPI app."""
    # This will be set by the main app setup
    from app.main import get_app_state
    state = get_app_state()
    return state.orchestrator


@router.post(
    "/start",
    response_model=StartSchedulingResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse}
    }
)
async def start_scheduling(
    request: StartSchedulingRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> StartSchedulingResponse:
    """
    Start interview scheduling workflow.
    
    This endpoint is called after a candidate passes the quiz/preselection.
    It generates recommended interview time slots based on recruiter availability.
    
    Args:
        request: StartSchedulingRequest with candidate, recruiter, job IDs
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        StartSchedulingResponse with suggested slots and schedule details
    
    Raises:
        HTTPException: If validation or processing fails
    """
    logger.info(
        f"POST /api/scheduling/start - Candidate: {request.candidate_id}, "
        f"Recruiter: {request.recruiter_id}, Job: {request.job_id}"
    )
    
    try:
        # Validation of quiz/application state is enforced by the Node gateway
        # before forwarding requests to this scheduling service.
        
        result = await orchestrator.start_interview_scheduling(
            candidate_id=request.candidate_id,
            recruiter_id=request.recruiter_id,
            job_id=request.job_id,
            application_id=request.application_id,
            interview_type=request.interview_type.value,
            interview_mode=request.interview_mode.value,
            duration_minutes=request.duration_minutes,
            optimization_options={
                "buffer_minutes": request.buffer_minutes,
                "interview_stage": request.interview_stage.value,
                "job_priority": request.job_priority.value,
                "candidate_level": request.candidate_level.value,
                "recruiter_preferences": request.recruiter_preferences.model_dump(),
                "candidate_timezone": request.candidate_timezone,
                "recruiter_timezone": request.recruiter_timezone,
                "top_n": request.top_n,
            },
        )
        
        return StartSchedulingResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            suggested_slots=result["suggested_slots"],
            recruiter_info=result["recruiter_info"],
            candidate_info=result["candidate_info"],
            job_info=result["job_info"],
            candidate_action_link=result.get("candidate_action_link"),
            alternative_strategies=result.get("alternative_strategies"),
            optimization_context=result.get("optimization_context"),
            message=result["message"]
        )
    
    except ValueError as e:
        logger.warning(f"Validation error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    
    except Exception as e:
        logger.error(f"Failed to start scheduling: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start interview scheduling"
        )


@router.post(
    "/confirm",
    response_model=ConfirmSlotResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse}
    }
)
async def confirm_slot(
    request: ConfirmSlotRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> ConfirmSlotResponse:
    """
    Confirm a selected interview slot.
    
    This endpoint:
    1. Validates the schedule exists and is in correct state
    2. Reserves the time slot
    3. Creates a Google Calendar event (Phase 2)
    4. Generates meeting link if online (Phase 2)
    5. Sends invitation email (Phase 2)
    
    Args:
        request: ConfirmSlotRequest with schedule ID and selected slot
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        ConfirmSlotResponse with confirmation details
    
    Raises:
        HTTPException: If validation or processing fails
    """
    logger.info(f"POST /api/scheduling/confirm - Schedule: {request.interview_schedule_id}")
    
    try:
        # Prepare slot data from TimeSlot object
        slot_data = {
            "start_time": request.selected_slot.start_time.isoformat(),
            "end_time": request.selected_slot.end_time.isoformat()
        }
        
        result = await orchestrator.confirm_slot(
            interview_schedule_id=request.interview_schedule_id,
            selected_slot=slot_data,
            location=request.location,
            notes=request.notes
        )
        
        return ConfirmSlotResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            message=result["message"],
            calendar_event_id=result.get("calendar_event_id"),
            meeting_link=result.get("meeting_link")
        )

    except SchedulingConflictError as e:
        logger.warning(f"Slot conflict: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(e),
                "code": "slot_conflict",
                "suggested_slots": e.suggested_slots,
            },
        )
    
    except ValueError as e:
        logger.warning(f"Validation error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    
    except Exception as e:
        logger.error(f"Failed to confirm slot: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to confirm interview slot"
        )


@router.post(
    "/reschedule",
    response_model=RescheduleResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse}
    }
)
async def reschedule_interview(
    request: RescheduleRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> RescheduleResponse:
    """
    Reschedule an interview to a different time slot.
    
    This endpoint:
    1. Validates the schedule exists and is confirmed
    2. Updates the Google Calendar event (Phase 2)
    3. Sends reschedule notification email (Phase 2)
    
    Args:
        request: RescheduleRequest with schedule ID and new slot
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        RescheduleResponse with reschedule details
    
    Raises:
        HTTPException: If validation or processing fails
    """
    logger.info(f"POST /api/scheduling/reschedule - Schedule: {request.interview_schedule_id}")
    
    try:
        slot_data = {
            "start_time": request.new_slot.start_time.isoformat(),
            "end_time": request.new_slot.end_time.isoformat()
        }
        
        result = await orchestrator.reschedule_interview(
            interview_schedule_id=request.interview_schedule_id,
            new_slot=slot_data,
            notes=request.notes
        )
        
        return RescheduleResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            message=result["message"]
        )

    except SchedulingConflictError as e:
        logger.warning(f"Reschedule conflict: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(e),
                "code": "slot_conflict",
                "suggested_slots": e.suggested_slots,
            },
        )
    
    except ValueError as e:
        logger.warning(f"Validation error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    
    except Exception as e:
        logger.error(f"Failed to reschedule interview: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reschedule interview"
        )


@router.post(
    "/cancel",
    response_model=CancelResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse}
    }
)
async def cancel_interview(
    request: CancelRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> CancelResponse:
    """
    Cancel an interview.
    
    This endpoint:
    1. Validates the schedule exists
    2. Deletes or cancels the Google Calendar event (Phase 2)
    3. Sends cancellation notification email (Phase 2)
    
    Args:
        request: CancelRequest with schedule ID and cancellation reason
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        CancelResponse with cancellation details
    
    Raises:
        HTTPException: If validation or processing fails
    """
    logger.info(f"POST /api/scheduling/cancel - Schedule: {request.interview_schedule_id}")
    
    try:
        result = await orchestrator.cancel_interview(
            interview_schedule_id=request.interview_schedule_id,
            reason=request.reason
        )
        
        return CancelResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            suggested_slots=result.get("suggested_slots"),
            message=result["message"]
        )
    
    except ValueError as e:
        logger.warning(f"Validation error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    
    except Exception as e:
        logger.error(f"Failed to cancel interview: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to cancel interview"
        )


@router.get(
    "/public/{candidate_action_token}",
    response_model=PublicScheduleResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def get_public_schedule(
    candidate_action_token: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> PublicScheduleResponse:
    """Get candidate-facing scheduling context by token."""
    logger.info("GET /api/scheduling/public/{token}")

    try:
        result = await orchestrator.get_public_schedule_by_token(candidate_action_token)
        return PublicScheduleResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to get public schedule: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve candidate schedule",
        )


@router.post(
    "/public/{candidate_action_token}/confirm",
    response_model=ConfirmSlotResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def confirm_slot_public(
    candidate_action_token: str,
    request: CandidateTokenConfirmRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> ConfirmSlotResponse:
    """Confirm interview slot via candidate tokenized flow."""
    logger.info("POST /api/scheduling/public/{token}/confirm")

    try:
        slot_data = {
            "start_time": request.selected_slot.start_time.isoformat(),
            "end_time": request.selected_slot.end_time.isoformat(),
        }
        result = await orchestrator.confirm_slot_by_candidate_token(
            candidate_action_token=candidate_action_token,
            selected_slot=slot_data,
            location=request.location,
            notes=request.notes or "",
        )
        return ConfirmSlotResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            message=result["message"],
            calendar_event_id=result.get("calendar_event_id"),
            meeting_link=result.get("meeting_link"),
        )
    except SchedulingConflictError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(e),
                "code": "slot_conflict",
                "suggested_slots": e.suggested_slots,
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to confirm public slot: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to confirm interview slot",
        )


@router.post(
    "/public/{candidate_action_token}/decline",
    response_model=CandidateDeclineResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def decline_slot_public(
    candidate_action_token: str,
    request: CandidateTokenDeclineRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> CandidateDeclineResponse:
    """Decline current schedule via candidate token and request a regenerated plan."""
    logger.info("POST /api/scheduling/public/{token}/decline")

    try:
        preferred_slots = []
        for slot in request.preferred_slots or []:
            preferred_slots.append(
                {
                    "start_time": slot.start_time.isoformat(),
                    "end_time": slot.end_time.isoformat(),
                }
            )

        result = await orchestrator.decline_slot_by_candidate_token(
            candidate_action_token=candidate_action_token,
            reason=request.reason or "",
            preferred_slots=preferred_slots,
            notes=request.notes or "",
        )
        return CandidateDeclineResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            suggested_slots=result.get("suggested_slots") or [],
            message=result["message"],
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to decline public slot: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to regenerate interview plan",
        )


@router.post(
    "/public/{candidate_action_token}/reschedule",
    response_model=RescheduleResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def reschedule_slot_public(
    candidate_action_token: str,
    request: CandidateTokenRescheduleRequest,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> RescheduleResponse:
    """Reschedule an already confirmed interview via candidate token."""
    logger.info("POST /api/scheduling/public/{token}/reschedule")

    try:
        slot_data = {
            "start_time": request.new_slot.start_time.isoformat(),
            "end_time": request.new_slot.end_time.isoformat(),
        }
        result = await orchestrator.reschedule_by_candidate_token(
            candidate_action_token=candidate_action_token,
            new_slot=slot_data,
            location=request.location,
            notes=request.notes or "",
        )
        return RescheduleResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            message=result["message"],
        )
    except SchedulingConflictError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(e),
                "code": "slot_conflict",
                "suggested_slots": e.suggested_slots,
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to reschedule public slot: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reschedule interview slot",
        )


@router.get(
    "/public/recruiter/{recruiter_action_token}/reschedule-request/approve",
    response_class=HTMLResponse,
    status_code=status.HTTP_200_OK,
)
async def approve_reschedule_request_public(
    recruiter_action_token: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> HTMLResponse:
    """Render recruiter approval confirmation page (safe GET)."""
    try:
        summary = await orchestrator.get_recruiter_reschedule_request_by_token(recruiter_action_token)
        pending_status = str(summary.get("pending_status") or "none").lower()

        if pending_status != "pending":
            return HTMLResponse(
                content=(
                    "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                    "<h2>Request already processed</h2>"
                    f"<p>Current request status: <strong>{summary.get('pending_status', 'none')}</strong></p>"
                    "</body></html>"
                )
            )

        requested_start = (summary.get("requested_slot") or {}).get("start_time") or "N/A"
        current_start = (summary.get("current_slot") or {}).get("start_time") or "N/A"

        return HTMLResponse(
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Approve reschedule request</h2>"
                f"<p><strong>Candidate:</strong> {summary.get('candidate_name', 'Candidate')}</p>"
                f"<p><strong>Job:</strong> {summary.get('job_title', 'Position')}</p>"
                f"<p><strong>Current slot:</strong> {current_start}</p>"
                f"<p><strong>Requested slot:</strong> {requested_start}</p>"
                "<form method='post'>"
                "<button type='submit' style='padding:10px 16px;background:#1456c0;color:#fff;border:0;border-radius:6px;cursor:pointer;'>Confirm Approve</button>"
                "</form>"
                "</body></html>"
            )
        )
    except ValueError as e:
        return HTMLResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Cannot approve request</h2>"
                f"<p>{str(e)}</p>"
                "</body></html>"
            ),
        )
    except Exception as e:
        logger.error(f"Failed to approve recruiter reschedule request: {str(e)}", exc_info=True)
        return HTMLResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Internal error</h2>"
                "<p>Failed to load approval page.</p>"
                "</body></html>"
            ),
        )


@router.post(
    "/public/recruiter/{recruiter_action_token}/reschedule-request/approve",
    response_class=HTMLResponse,
    status_code=status.HTTP_200_OK,
)
async def approve_reschedule_request_public_submit(
    recruiter_action_token: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> HTMLResponse:
    """Execute recruiter approval action (POST)."""
    try:
        result = await orchestrator.recruiter_approve_reschedule_request_by_token(recruiter_action_token)
        return HTMLResponse(
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Reschedule request approved</h2>"
                f"<p>{result.get('message', 'The interview has been rescheduled successfully.')}</p>"
                "</body></html>"
            )
        )
    except ValueError as e:
        return HTMLResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Cannot approve request</h2>"
                f"<p>{str(e)}</p>"
                "</body></html>"
            ),
        )
    except Exception as e:
        logger.error(f"Failed to approve recruiter reschedule request: {str(e)}", exc_info=True)
        return HTMLResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Internal error</h2>"
                "<p>Failed to approve the reschedule request.</p>"
                "</body></html>"
            ),
        )


@router.get(
    "/public/recruiter/{recruiter_action_token}/reschedule-request/decline",
    response_class=HTMLResponse,
    status_code=status.HTTP_200_OK,
)
async def decline_reschedule_request_public(
    recruiter_action_token: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> HTMLResponse:
    """Render recruiter decline confirmation page (safe GET)."""
    try:
        summary = await orchestrator.get_recruiter_reschedule_request_by_token(recruiter_action_token)
        pending_status = str(summary.get("pending_status") or "none").lower()

        if pending_status != "pending":
            return HTMLResponse(
                content=(
                    "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                    "<h2>Request already processed</h2>"
                    f"<p>Current request status: <strong>{summary.get('pending_status', 'none')}</strong></p>"
                    "</body></html>"
                )
            )

        requested_start = (summary.get("requested_slot") or {}).get("start_time") or "N/A"
        current_start = (summary.get("current_slot") or {}).get("start_time") or "N/A"

        return HTMLResponse(
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Decline reschedule request</h2>"
                f"<p><strong>Candidate:</strong> {summary.get('candidate_name', 'Candidate')}</p>"
                f"<p><strong>Job:</strong> {summary.get('job_title', 'Position')}</p>"
                f"<p><strong>Current slot:</strong> {current_start}</p>"
                f"<p><strong>Requested slot:</strong> {requested_start}</p>"
                "<form method='post'>"
                "<button type='submit' style='padding:10px 16px;background:#b42318;color:#fff;border:0;border-radius:6px;cursor:pointer;'>Confirm Decline</button>"
                "</form>"
                "</body></html>"
            )
        )
    except ValueError as e:
        return HTMLResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Cannot decline request</h2>"
                f"<p>{str(e)}</p>"
                "</body></html>"
            ),
        )
    except Exception as e:
        logger.error(f"Failed to decline recruiter reschedule request: {str(e)}", exc_info=True)
        return HTMLResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Internal error</h2>"
                "<p>Failed to load decline page.</p>"
                "</body></html>"
            ),
        )


@router.post(
    "/public/recruiter/{recruiter_action_token}/reschedule-request/decline",
    response_class=HTMLResponse,
    status_code=status.HTTP_200_OK,
)
async def decline_reschedule_request_public_submit(
    recruiter_action_token: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> HTMLResponse:
    """Execute recruiter decline action (POST)."""
    try:
        result = await orchestrator.recruiter_decline_reschedule_request_by_token(recruiter_action_token)
        return HTMLResponse(
            content=f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Reschedule Declined</title>
                <style>
                    body {{
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        padding: 32px 16px;
                        background: #f5f7fa;
                        margin: 0;
                    }}
                    .container {{
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 80vh;
                    }}
                    .card {{
                        width: 100%;
                        max-width: 860px;
                        background: #ffffff;
                        border: 1px solid #dce4ef;
                        border-radius: 16px;
                        box-shadow: 0 8px 24px rgba(8, 28, 66, 0.08);
                        padding: 32px 24px;
                        text-align: center;
                    }}
                    .success-icon {{
                        font-size: 48px;
                        margin-bottom: 16px;
                    }}
                    h1 {{
                        margin: 0 0 16px 0;
                        color: #7a4a0f;
                        font-size: 28px;
                    }}
                    .message {{
                        margin-top: 16px;
                        padding: 12px 14px;
                        border-radius: 10px;
                        background: #fff9f0;
                        border: 1px solid #ffe0c6;
                        color: #7a4a0f;
                        font-size: 16px;
                    }}
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="card">
                        <div class="success-icon">✓</div>
                        <h1>Reschedule Declined</h1>
                        <div class="message">
                            {result.get('message', 'The candidate has been notified. The original interview time remains scheduled.')}
                        </div>
                    </div>
                </div>
            </body>
            </html>
            """
        )
    except ValueError as e:
        return HTMLResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Error</title>
                <style>
                    body {{
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        padding: 32px 16px;
                        background: #f5f7fa;
                        margin: 0;
                    }}
                    .container {{
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 80vh;
                    }}
                    .card {{
                        width: 100%;
                        max-width: 860px;
                        background: #ffffff;
                        border: 1px solid #dce4ef;
                        border-radius: 16px;
                        box-shadow: 0 8px 24px rgba(8, 28, 66, 0.08);
                        padding: 32px 24px;
                    }}
                    h1 {{
                        margin: 0 0 16px 0;
                        color: #8c1d18;
                        font-size: 28px;
                    }}
                    .error-message {{
                        margin-top: 16px;
                        padding: 12px 14px;
                        border-radius: 10px;
                        background: #fff1f1;
                        color: #8c1d18;
                        font-size: 16px;
                    }}
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="card">
                        <h1>⚠ Cannot Decline Request</h1>
                        <div class="error-message">{str(e)}</div>
                    </div>
                </div>
            </body>
            </html>
            """,
        )
    except Exception as e:
        logger.error(f"Failed to decline recruiter reschedule request: {str(e)}", exc_info=True)
        return HTMLResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=(
                "<html><body style='font-family:Arial,sans-serif;padding:24px;'>"
                "<h2>Internal error</h2>"
                "<p>Failed to decline the reschedule request.</p>"
                "</body></html>"
            ),
        )


@router.get(
    "/public/{candidate_action_token}/alternatives",
    response_model=AlternativeSlotsResponse,
    status_code=status.HTTP_200_OK,
    responses={
        400: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
)
async def get_public_alternatives(
    candidate_action_token: str,
    top_n: Optional[int] = 3,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator),
) -> AlternativeSlotsResponse:
    """Get optimized alternative slots by candidate token."""
    logger.info("GET /api/scheduling/public/{token}/alternatives")

    try:
        result = await orchestrator.get_alternative_slots_by_token(
            candidate_action_token=candidate_action_token,
            top_n=max(1, min(int(top_n or 3), 10)),
        )
        return AlternativeSlotsResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to get public alternative slots: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate alternative slots",
        )


@router.get(
    "/{interview_schedule_id}",
    response_model=InterviewScheduleResponse,
    status_code=status.HTTP_200_OK,
    responses={
        404: {"model": ErrorResponse},
        500: {"model": ErrorResponse}
    }
)
async def get_schedule(
    interview_schedule_id: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> InterviewScheduleResponse:
    """
    Get details of a specific interview schedule.
    
    Args:
        interview_schedule_id: Schedule ID
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        InterviewScheduleResponse with full schedule details
    
    Raises:
        HTTPException: If schedule not found
    """
    logger.info(f"GET /api/scheduling/{interview_schedule_id}")
    
    try:
        schedule = await orchestrator.schedule_repo.get_by_id(interview_schedule_id)
        
        if not schedule:
            logger.warning(f"Schedule not found: {interview_schedule_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Interview schedule not found: {interview_schedule_id}"
            )
        
        # Convert MongoDB ObjectId to string for response
        schedule["_id"] = str(schedule["_id"])
        
        return InterviewScheduleResponse(**schedule)
    
    except HTTPException:
        raise
    
    except Exception as e:
        logger.error(f"Failed to get schedule: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve interview schedule"
        )


@router.get(
    "/candidate/{candidate_id}",
    response_model=list[InterviewScheduleResponse],
    status_code=status.HTTP_200_OK
)
async def get_schedules_by_candidate(
    candidate_id: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> list[InterviewScheduleResponse]:
    """
    Get all interview schedules for a candidate.
    
    Args:
        candidate_id: Candidate ID
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        List of InterviewScheduleResponse objects
    """
    logger.info(f"GET /api/scheduling/candidate/{candidate_id}")
    
    try:
        schedules = await orchestrator.schedule_repo.get_by_candidate(candidate_id)
        
        # Convert ObjectIds to strings
        for schedule in schedules:
            schedule["_id"] = str(schedule["_id"])
        
        return [InterviewScheduleResponse(**s) for s in schedules]
    
    except Exception as e:
        logger.error(f"Failed to get candidate schedules: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve candidate schedules"
        )


@router.get(
    "/recruiter/{recruiter_id}",
    response_model=list[InterviewScheduleResponse],
    status_code=status.HTTP_200_OK
)
async def get_schedules_by_recruiter(
    recruiter_id: str,
    orchestrator: SchedulingOrchestrator = Depends(get_orchestrator)
) -> list[InterviewScheduleResponse]:
    """
    Get all interview schedules for a recruiter.
    
    Args:
        recruiter_id: Recruiter ID
        orchestrator: Scheduling orchestrator (injected)
    
    Returns:
        List of InterviewScheduleResponse objects
    """
    logger.info(f"GET /api/scheduling/recruiter/{recruiter_id}")
    
    try:
        schedules = await orchestrator.schedule_repo.get_by_recruiter(recruiter_id)
        
        # Convert ObjectIds to strings
        for schedule in schedules:
            schedule["_id"] = str(schedule["_id"])
        
        return [InterviewScheduleResponse(**s) for s in schedules]
    
    except Exception as e:
        logger.error(f"Failed to get recruiter schedules: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve recruiter schedules"
        )
