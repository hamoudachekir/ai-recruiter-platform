import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, status
from datetime import datetime

from app.schemas.scheduling import (
    StartSchedulingRequest,
    StartSchedulingResponse,
    ConfirmSlotRequest,
    ConfirmSlotResponse,
    RescheduleRequest,
    RescheduleResponse,
    CancelRequest,
    CancelResponse,
    ErrorResponse,
    InterviewScheduleResponse
)
from app.services.scheduling_orchestrator import SchedulingOrchestrator

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
            duration_minutes=request.duration_minutes
        )
        
        return StartSchedulingResponse(
            interview_schedule_id=result["interview_schedule_id"],
            status=result["status"],
            suggested_slots=result["suggested_slots"],
            recruiter_info=result["recruiter_info"],
            candidate_info=result["candidate_info"],
            job_info=result["job_info"],
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
