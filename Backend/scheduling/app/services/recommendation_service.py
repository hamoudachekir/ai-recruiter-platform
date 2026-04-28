import logging
from datetime import datetime, timedelta, time, timezone
from typing import List, Tuple, Optional, Dict, Any

logger = logging.getLogger(__name__)


class RecommendationService:
    """
    Service for generating recommended interview time slots.
    Uses recruiter availability and business rules to find optimal scheduling windows.
    """
    
    def __init__(
        self,
        working_hours_start: int = 9,  # 09:00
        working_hours_end: int = 17,   # 17:00
        lunch_start: int = 12,
        lunch_end: int = 13,
        scheduling_days_ahead: int = 7,
        timezone: str = "UTC"
    ):
        """
        Initialize recommendation service with business rules.
        
        Args:
            working_hours_start: Start hour of working day (0-23)
            working_hours_end: End hour of working day (0-23)
            lunch_start: Start hour of lunch break (0-23)
            lunch_end: End hour of lunch break (0-23)
            scheduling_days_ahead: Number of days to look ahead for available slots
            timezone: Timezone identifier
        """
        self.working_hours_start = working_hours_start
        self.working_hours_end = working_hours_end
        self.lunch_start = lunch_start
        self.lunch_end = lunch_end
        self.scheduling_days_ahead = scheduling_days_ahead
        self.timezone = timezone
    
    def generate_candidate_slots(
        self,
        recruiter_busy_slots: List[Tuple[datetime, datetime]],
        interview_duration: int = 60,
        start_date: Optional[datetime] = None,
        top_n: int = 5,
        optimization_context: Optional[Dict[str, Any]] = None,
    ) -> List[dict]:
        """
        Generate recommended interview time slots avoiding recruiter busy times.
        
        Args:
            recruiter_busy_slots: List of (start, end) datetime tuples when recruiter is busy
            interview_duration: Duration of interview in minutes
            start_date: Starting date for recommendations (default: today)
            top_n: Number of recommended slots to return
            
        Returns:
            List[dict]: Recommended time slots with scores, sorted by score descending
        """
        if start_date is None:
            start_date = datetime.now(timezone.utc).replace(tzinfo=None)
            # Align to start of working hours
            start_date = start_date.replace(
                hour=self.working_hours_start,
                minute=0,
                second=0,
                microsecond=0,
            )
        else:
            start_date = start_date.replace(second=0, microsecond=0)
        
        logger.info(
            f"Generating {top_n} interview slots for {self.scheduling_days_ahead} days "
            f"with {interview_duration}min duration, starting {start_date}"
        )
        
        # Convert busy slots to a set for fast lookup
        busy_intervals = self._normalize_busy_slots(recruiter_busy_slots)
        
        # Generate potential slots
        all_slots = []
        
        for day_offset in range(self.scheduling_days_ahead):
            day_start = start_date + timedelta(days=day_offset)
            
            # Skip weekends (Saturday=5, Sunday=6)
            if day_start.weekday() >= 5:
                logger.debug(f"Skipping weekend: {day_start.date()}")
                continue
            
            # Generate slots for this day
            day_slots = self._generate_day_slots(
                day_start,
                interview_duration,
                busy_intervals
            )
            
            all_slots.extend(day_slots)
        
        # Score and sort slots
        scored_slots = [
            {
                **slot,
                **self._score_slot(slot, start_date, optimization_context)
            }
            for slot in all_slots
        ]
        
        # Sort by score (descending) and return top N
        scored_slots.sort(key=lambda x: x["score"], reverse=True)
        top_slots = scored_slots[:top_n]
        
        logger.info(f"Generated {len(top_slots)} recommended slots from {len(all_slots)} candidates")
        
        return top_slots

    def build_strategy_views(self, scored_slots: List[dict], top_n: int = 3) -> Dict[str, List[dict]]:
        """Build strategy-oriented views from already scored slots."""
        safe_top_n = max(1, int(top_n))
        if not scored_slots:
            return {
                "closest_slots": [],
                "comfortable_slots": [],
                "urgent_slots": [],
                "balanced_slots": [],
            }

        closest_slots = sorted(
            scored_slots,
            key=lambda slot: (slot.get("days_ahead", 999), -slot.get("score", 0.0)),
        )[:safe_top_n]

        comfortable_slots = sorted(
            scored_slots,
            key=lambda slot: (
                -float(slot.get("score_breakdown", {}).get("comfort", 0.0)),
                -slot.get("score", 0.0),
            ),
        )[:safe_top_n]

        urgent_slots = sorted(
            scored_slots,
            key=lambda slot: (
                -float(slot.get("score_breakdown", {}).get("urgency", 0.0)),
                slot.get("days_ahead", 999),
                -slot.get("score", 0.0),
            ),
        )[:safe_top_n]

        balanced_slots = sorted(
            scored_slots,
            key=lambda slot: -slot.get("score", 0.0),
        )[:safe_top_n]

        return {
            "closest_slots": [self._clean_strategy_slot(slot) for slot in closest_slots],
            "comfortable_slots": [self._clean_strategy_slot(slot) for slot in comfortable_slots],
            "urgent_slots": [self._clean_strategy_slot(slot) for slot in urgent_slots],
            "balanced_slots": [self._clean_strategy_slot(slot) for slot in balanced_slots],
        }
    
    def is_slot_available(
        self,
        slot_start: datetime,
        slot_end: datetime,
        recruiter_busy_slots: List[Tuple[datetime, datetime]]
    ) -> bool:
        """
        Check if a specific time slot is available for interview.
        
        Args:
            slot_start: Start datetime of slot
            slot_end: End datetime of slot
            recruiter_busy_slots: List of busy intervals
            
        Returns:
            bool: True if slot is available, False if conflicts exist
        """
        # Check if slot is within working hours
        day_start = slot_start.replace(hour=self.working_hours_start, minute=0, second=0)
        day_end = slot_start.replace(hour=self.working_hours_end, minute=0, second=0)
        
        if slot_start < day_start or slot_end > day_end:
            return False
        
        # Check if slot conflicts with lunch
        lunch_start_time = time(self.lunch_start, 0)
        lunch_end_time = time(self.lunch_end, 0)
        
        slot_start_time = slot_start.time()
        slot_end_time = slot_end.time()
        
        if (slot_start_time < lunch_end_time and slot_end_time > lunch_start_time):
            return False
        
        # Check if slot conflicts with recruiter busy time
        for busy_start, busy_end in recruiter_busy_slots:
            if self._intervals_overlap(slot_start, slot_end, busy_start, busy_end):
                return False
        
        return True
    
    def _generate_day_slots(
        self,
        day_start: datetime,
        interview_duration: int,
        busy_intervals: List[Tuple[datetime, datetime]]
    ) -> List[dict]:
        """
        Generate available slots for a single day.
        
        Args:
            day_start: Start of the day
            interview_duration: Duration in minutes
            busy_intervals: Busy intervals for the day
            
        Returns:
            List[dict]: Available slots for the day
        """
        slots = []
        
        # Create working hour boundaries
        work_start = day_start.replace(
            hour=self.working_hours_start,
            minute=0,
            second=0,
            microsecond=0,
        )
        work_end = day_start.replace(
            hour=self.working_hours_end,
            minute=0,
            second=0,
            microsecond=0,
        )
        lunch_start = day_start.replace(
            hour=self.lunch_start,
            minute=0,
            second=0,
            microsecond=0,
        )
        lunch_end = day_start.replace(
            hour=self.lunch_end,
            minute=0,
            second=0,
            microsecond=0,
        )
        
        # Minimum start: never schedule a slot in the past
        now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
        if work_start < now_naive:
            # Snap to next 30-min boundary after now
            minutes_past = int((now_naive - work_start).total_seconds() / 60)
            snapped_minutes = ((minutes_past // 30) + 1) * 30
            work_start = work_start + timedelta(minutes=snapped_minutes)

        # Generate 30-minute intervals
        current_time = work_start
        interval_minutes = 30

        while current_time + timedelta(minutes=interview_duration) <= work_end:
            slot_end = current_time + timedelta(minutes=interview_duration)

            # Check slot doesn't cross lunch break
            if not self._intervals_overlap(current_time, slot_end, lunch_start, lunch_end):
                # Check slot doesn't conflict with busy time
                is_available = True
                for busy_start, busy_end in busy_intervals:
                    if self._intervals_overlap(current_time, slot_end, busy_start, busy_end):
                        is_available = False
                        break
                
                if is_available:
                    slots.append({
                        "start_time": current_time,
                        "end_time": slot_end,
                        "date": current_time.date().isoformat(),
                        "time_start": current_time.time().isoformat(),
                        "time_end": slot_end.time().isoformat(),
                    })
            
            current_time += timedelta(minutes=interval_minutes)
        
        return slots
    
    def _score_slot(
        self,
        slot: dict,
        reference_date: datetime,
        optimization_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Compute a full score object with breakdown and strategy tags."""
        optimization_context = optimization_context or {}
        slot_start = slot["start_time"]
        hour = slot_start.hour
        days_ahead = max(0, (slot_start.date() - reference_date.date()).days)

        # Base recency score
        if days_ahead == 0:
            proximity_score = 3.0
        elif days_ahead == 1:
            proximity_score = 2.5
        elif days_ahead <= 3:
            proximity_score = 2.0
        else:
            proximity_score = max(0.5, 3.0 - (days_ahead * 0.3))

        # Base comfort score by hour
        if 10 <= hour < 12:
            comfort_score = 2.8
        elif 14 <= hour < 16:
            comfort_score = 2.6
        elif 9 <= hour < 17:
            comfort_score = 1.9
        else:
            comfort_score = 1.0

        interview_stage = str(optimization_context.get("interview_stage") or "technical").lower()
        stage_bonus = 0.0
        if interview_stage == "rh":
            if 9 <= hour < 12:
                stage_bonus = 0.9
            elif 14 <= hour < 17:
                stage_bonus = 0.6
        elif interview_stage == "technical":
            if 10 <= hour < 12:
                stage_bonus = 1.0
            elif 14 <= hour < 16:
                stage_bonus = 0.7
        elif interview_stage == "final":
            if 11 <= hour < 12 or 15 <= hour < 17:
                stage_bonus = 1.0
            elif 14 <= hour < 15:
                stage_bonus = 0.5

        job_priority = str(optimization_context.get("job_priority") or "normal").lower()
        priority_multiplier = {
            "low": 0.85,
            "normal": 1.0,
            "high": 1.2,
            "urgent": 1.45,
        }.get(job_priority, 1.0)
        proximity_score *= priority_multiplier

        urgency_score = 0.0
        if job_priority in {"high", "urgent"} and days_ahead <= 2:
            urgency_score += 0.8
        if job_priority == "urgent" and days_ahead > 3:
            urgency_score -= 0.9

        recruiter_preferences = optimization_context.get("recruiter_preferences") or {}
        preferred_ranges = recruiter_preferences.get("preferred_time_ranges") or []
        avoid_ranges = recruiter_preferences.get("avoid_time_ranges") or []
        preferred_days = {
            int(day)
            for day in recruiter_preferences.get("preferred_days", [])
            if str(day).isdigit() and 0 <= int(day) <= 6
        }

        if preferred_days and slot_start.weekday() in preferred_days:
            comfort_score += 0.7
        if self._hour_in_ranges(hour, preferred_ranges):
            comfort_score += 1.0
        if self._hour_in_ranges(hour, avoid_ranges):
            comfort_score -= 1.5

        candidate_level = str(optimization_context.get("candidate_level") or "intermediate").lower()
        level_bonus = 0.0
        if candidate_level == "junior" and 9 <= hour < 11:
            level_bonus += 0.25
        elif candidate_level == "senior" and 14 <= hour < 17:
            level_bonus += 0.25

        total_score = min(10.0, max(0.5, proximity_score + comfort_score + stage_bonus + urgency_score + level_bonus))

        tags: List[str] = []
        if days_ahead <= 1:
            tags.append("closest")
        if comfort_score >= 2.6:
            tags.append("comfortable")
        if urgency_score > 0:
            tags.append("urgent-priority")
        if stage_bonus >= 0.9:
            tags.append(f"stage-{interview_stage}")

        return {
            "score": round(total_score, 1),
            "days_ahead": days_ahead,
            "score_breakdown": {
                "proximity": round(proximity_score, 2),
                "comfort": round(comfort_score, 2),
                "stage": round(stage_bonus, 2),
                "urgency": round(urgency_score, 2),
                "candidate_level": round(level_bonus, 2),
            },
            "strategy_tags": tags,
        }

    def _calculate_slot_score(self, slot: dict, reference_date: datetime) -> float:
        """
        Calculate recommendation score for a slot.
        Higher scores = more recommended.
        
        Scoring factors:
        - Closer to reference date (avoid too far in future): up to 3 points
        - Morning slots preferred: 2 points
        - Mid-afternoon slots OK: 1 point
        - Time since reference: earlier availability scores higher
        
        Args:
            slot: Slot dict with start_time, end_time
            reference_date: Reference date for scoring
            
        Returns:
            float: Score between 1-10
        """
        return self._score_slot(slot, reference_date, {}).get("score", 5.0)

    @staticmethod
    def _parse_hour_range(range_str: str) -> Optional[Tuple[int, int]]:
        """Parse HH:MM-HH:MM ranges and return start/end hours."""
        value = str(range_str or "").strip()
        if "-" not in value:
            return None
        start_raw, end_raw = value.split("-", 1)
        try:
            start_hour = int(start_raw.split(":")[0])
            end_hour = int(end_raw.split(":")[0])
        except Exception:
            return None
        if not (0 <= start_hour <= 23 and 0 <= end_hour <= 23):
            return None
        return start_hour, end_hour

    def _hour_in_ranges(self, hour: int, ranges: List[str]) -> bool:
        for item in ranges:
            parsed = self._parse_hour_range(item)
            if not parsed:
                continue
            start_hour, end_hour = parsed
            if start_hour <= hour < max(start_hour + 1, end_hour):
                return True
        return False

    @staticmethod
    def _clean_strategy_slot(slot: dict) -> dict:
        clean = dict(slot)
        clean.pop("days_ahead", None)
        return clean
    
    def _normalize_busy_slots(
        self,
        busy_slots: List[Tuple[datetime, datetime]]
    ) -> List[Tuple[datetime, datetime]]:
        """
        Normalize and merge overlapping busy slots.
        
        Args:
            busy_slots: List of busy intervals
            
        Returns:
            List[Tuple]: Normalized non-overlapping intervals
        """
        if not busy_slots:
            return []
        
        # Sort by start time
        sorted_slots = sorted(busy_slots, key=lambda x: x[0])
        
        # Merge overlapping intervals
        normalized = [sorted_slots[0]]
        
        for current_start, current_end in sorted_slots[1:]:
            last_start, last_end = normalized[-1]
            
            if current_start <= last_end:
                # Overlapping, merge
                normalized[-1] = (last_start, max(last_end, current_end))
            else:
                # Non-overlapping, add
                normalized.append((current_start, current_end))
        
        return normalized
    
    def _intervals_overlap(
        self,
        start1: datetime,
        end1: datetime,
        start2: datetime,
        end2: datetime
    ) -> bool:
        """
        Check if two time intervals overlap.
        
        Args:
            start1, end1: First interval
            start2, end2: Second interval
            
        Returns:
            bool: True if intervals overlap
        """
        return start1 < end2 and start2 < end1


def create_recommendation_service(config) -> RecommendationService:
    """
    Factory function to create RecommendationService from config.
    
    Args:
        config: Configuration object with scheduling parameters
        
    Returns:
        RecommendationService: Initialized service
    """
    return RecommendationService(
        working_hours_start=config.working_hours_start,
        working_hours_end=config.working_hours_end,
        lunch_start=config.lunch_start,
        lunch_end=config.lunch_end,
        scheduling_days_ahead=config.scheduling_days_ahead,
        timezone=config.timezone_default
    )
