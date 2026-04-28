from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Any
from datetime import datetime
from enum import Enum


class InterviewTypeEnum(str, Enum):
    PHONE = "phone"
    VIDEO = "video"
    IN_PERSON = "in_person"
    ASSESSMENT = "assessment"


class InterviewModeEnum(str, Enum):
    SYNCHRONOUS = "synchronous"
    ASYNCHRONOUS = "asynchronous"


class InterviewStageEnum(str, Enum):
    RH = "rh"
    TECHNICAL = "technical"
    FINAL = "final"


class JobPriorityEnum(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class CandidateLevelEnum(str, Enum):
    JUNIOR = "junior"
    INTERMEDIATE = "intermediate"
    SENIOR = "senior"


class InterviewStatusEnum(str, Enum):
    DRAFT = "draft"
    SUGGESTED_SLOTS_READY = "suggested_slots_ready"
    CONFIRMED = "confirmed"
    RESCHEDULED = "rescheduled"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class EmailStatusEnum(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    BOUNCED = "bounced"


class ScheduleLogActionEnum(str, Enum):
    SCHEDULING_STARTED = "scheduling_started"
    SLOTS_GENERATED = "slots_generated"
    SLOT_CONFIRMED = "slot_confirmed"
    CALENDAR_EVENT_CREATED = "calendar_event_created"
    INVITATION_SENT = "invitation_sent"
    INTERVIEW_RESCHEDULED = "interview_rescheduled"
    INTERVIEW_CANCELLED = "interview_cancelled"
    EMAIL_FAILED = "email_failed"
    CALENDAR_ERROR = "calendar_error"
    REMINDER_SCHEDULED = "reminder_scheduled"
    REMINDER_SENT = "reminder_sent"


class RecruiterPreferences(BaseModel):
    """Recruiter preferences used by slot optimization."""
    preferred_time_ranges: List[str] = Field(default_factory=list)
    avoid_time_ranges: List[str] = Field(default_factory=list)
    preferred_days: List[int] = Field(default_factory=list)

    @field_validator("preferred_days")
    @classmethod
    def validate_preferred_days(cls, values: List[int]) -> List[int]:
        valid = []
        for day in values:
            if 0 <= int(day) <= 6:
                valid.append(int(day))
        return valid


class TimeSlot(BaseModel):
    """Represents a suggested interview time slot."""
    start_time: datetime
    end_time: datetime
    score: float = Field(default=5.0, gt=0, le=10)  # 1-10, higher = more recommended


class StartSchedulingRequest(BaseModel):
    """Request to start interview scheduling workflow."""
    candidate_id: str = Field(..., min_length=1)
    recruiter_id: str = Field(..., min_length=1)
    job_id: str = Field(..., min_length=1)
    application_id: str = Field(..., min_length=1)
    interview_type: InterviewTypeEnum = InterviewTypeEnum.VIDEO
    interview_mode: InterviewModeEnum = InterviewModeEnum.SYNCHRONOUS
    interview_stage: InterviewStageEnum = InterviewStageEnum.TECHNICAL
    duration_minutes: Optional[int] = Field(default=None, ge=15, le=480)
    buffer_minutes: Optional[int] = Field(default=None, ge=0, le=120)
    job_priority: JobPriorityEnum = JobPriorityEnum.NORMAL
    candidate_level: CandidateLevelEnum = CandidateLevelEnum.INTERMEDIATE
    recruiter_preferences: RecruiterPreferences = Field(default_factory=RecruiterPreferences)
    candidate_timezone: Optional[str] = Field(default=None, max_length=80)
    recruiter_timezone: Optional[str] = Field(default=None, max_length=80)
    top_n: int = Field(default=5, ge=3, le=10)
    
    @field_validator('duration_minutes')
    @classmethod
    def validate_duration(cls, v):
        if v is None:
            return v
        if v % 15 != 0:
            raise ValueError('Duration must be in 15-minute increments')
        return v


class ConfirmSlotRequest(BaseModel):
    """Request to confirm a selected interview slot."""
    interview_schedule_id: str = Field(..., min_length=1)
    selected_slot: TimeSlot
    location: Optional[str] = None
    notes: Optional[str] = Field(default="", max_length=500)


class CandidateTokenConfirmRequest(BaseModel):
    """Candidate-facing confirmation request using tokenized access."""
    selected_slot: TimeSlot
    location: Optional[str] = None
    notes: Optional[str] = Field(default="", max_length=500)


class CandidateTokenDeclineRequest(BaseModel):
    """Candidate-facing decline request with optional preferred alternatives."""
    reason: Optional[str] = Field(default="", max_length=500)
    preferred_slots: Optional[List[TimeSlot]] = None
    notes: Optional[str] = Field(default="", max_length=500)


class CandidateTokenRescheduleRequest(BaseModel):
    """Candidate-facing reschedule request using tokenized access."""
    new_slot: TimeSlot
    location: Optional[str] = None
    notes: Optional[str] = Field(default="", max_length=500)


class RescheduleRequest(BaseModel):
    """Request to reschedule an interview."""
    interview_schedule_id: str = Field(..., min_length=1)
    new_slot: TimeSlot
    notes: Optional[str] = Field(default="", max_length=500)


class CancelRequest(BaseModel):
    """Request to cancel an interview."""
    interview_schedule_id: str = Field(..., min_length=1)
    reason: str = Field(..., min_length=1, max_length=500)


class InterviewScheduleBase(BaseModel):
    """Base schema for interview schedule."""
    candidate_id: str
    recruiter_id: str
    job_id: str
    application_id: str
    interview_type: str
    interview_mode: str
    interview_stage: Optional[str] = None
    duration_minutes: int
    buffer_minutes: int = 0
    job_priority: Optional[str] = None
    candidate_level: Optional[str] = None
    status: str = InterviewStatusEnum.DRAFT.value
    email_status: str = EmailStatusEnum.PENDING.value
    notes: Optional[str] = ""


class InterviewScheduleCreate(InterviewScheduleBase):
    """Schema for creating interview schedule."""
    pass


class InterviewScheduleUpdate(BaseModel):
    """Schema for updating interview schedule."""
    status: Optional[str] = None
    email_status: Optional[str] = None
    confirmed_slot: Optional[Dict[str, Any]] = None
    calendar_event_id: Optional[str] = None
    meeting_link: Optional[str] = None
    location: Optional[str] = None
    notes: Optional[str] = None


class InterviewScheduleResponse(InterviewScheduleBase):
    """Schema for interview schedule response."""
    id: str = Field(alias="_id")
    suggested_slots: List[Dict[str, Any]] = []
    confirmed_slot: Optional[Dict[str, Any]] = None
    calendar_event_id: Optional[str] = None
    meeting_link: Optional[str] = None
    location: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    
    class Config:
        populate_by_name = True


class ScheduleLogBase(BaseModel):
    """Base schema for schedule log."""
    interview_schedule_id: str
    action: str
    details: Dict[str, Any] = {}


class ScheduleLogCreate(ScheduleLogBase):
    """Schema for creating schedule log."""
    pass


class ScheduleLogResponse(ScheduleLogBase):
    """Schema for schedule log response."""
    id: str = Field(alias="_id")
    created_at: datetime
    
    class Config:
        populate_by_name = True


class StartSchedulingResponse(BaseModel):
    """Response from start scheduling endpoint."""
    interview_schedule_id: str
    status: str
    suggested_slots: List[TimeSlot]
    recruiter_info: Dict[str, Any]
    candidate_info: Dict[str, Any]
    job_info: Dict[str, Any]
    candidate_action_link: Optional[str] = None
    alternative_strategies: Optional[Dict[str, List[TimeSlot]]] = None
    optimization_context: Optional[Dict[str, Any]] = None
    message: str


class ConfirmSlotResponse(BaseModel):
    """Response from confirm slot endpoint."""
    interview_schedule_id: str
    status: str
    message: str
    calendar_event_id: Optional[str] = None
    meeting_link: Optional[str] = None
    suggested_slots: Optional[List[TimeSlot]] = None


class RescheduleResponse(BaseModel):
    """Response from reschedule endpoint."""
    interview_schedule_id: str
    status: str
    message: str


class CancelResponse(BaseModel):
    """Response from cancel endpoint."""
    interview_schedule_id: str
    status: str
    suggested_slots: Optional[List[TimeSlot]] = None
    message: str


class PublicScheduleResponse(BaseModel):
    """Candidate-friendly schedule response for token-based interaction."""
    interview_schedule_id: str
    status: str
    interview_type: str
    interview_mode: str
    interview_stage: Optional[str] = None
    duration_minutes: int
    buffer_minutes: int = 0
    suggested_slots: List[TimeSlot]
    confirmed_slot: Optional[Dict[str, Any]] = None
    candidate_timezone: Optional[str] = None
    recruiter_timezone: Optional[str] = None
    candidate_action_link: Optional[str] = None
    candidate_action_expires_at: Optional[datetime] = None
    message: str


class AlternativeSlotsResponse(BaseModel):
    """Response with optimized alternative slots."""
    interview_schedule_id: str
    suggested_slots: List[TimeSlot]
    message: str


class CandidateDeclineResponse(BaseModel):
    """Response after candidate declines current proposal and requests replanning."""
    interview_schedule_id: str
    status: str
    suggested_slots: List[TimeSlot]
    message: str


class ErrorResponse(BaseModel):
    """Standard error response."""
    error: str
    detail: Optional[str] = None
    code: Optional[str] = None
