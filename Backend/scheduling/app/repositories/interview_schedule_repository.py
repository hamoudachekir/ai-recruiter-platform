import logging
from typing import List, Optional, Dict, Any
from datetime import datetime
from bson import ObjectId
from pymongo import MongoClient
from pymongo.errors import PyMongoError

logger = logging.getLogger(__name__)


class InterviewScheduleRepository:
    """
    Repository for managing interview schedule documents in MongoDB.
    """
    
    def __init__(self, db):
        """
        Initialize repository with MongoDB database instance.
        
        Args:
            db: MongoDB database instance
        """
        self.db = db
        self.collection_name = "interview_schedules"
        self.collection = db[self.collection_name]
    
    async def create(self, schedule_data: Dict[str, Any]) -> str:
        """
        Create a new interview schedule.
        
        Args:
            schedule_data: Dictionary containing schedule information
            
        Returns:
            str: ID of created document
            
        Raises:
            PyMongoError: If database operation fails
        """
        try:
            schedule_data['created_at'] = datetime.utcnow()
            schedule_data['updated_at'] = datetime.utcnow()
            
            result = await self.collection.insert_one(schedule_data)
            logger.info(f"Created interview schedule: {result.inserted_id}")
            return str(result.inserted_id)
        except PyMongoError as e:
            logger.error(f"Failed to create interview schedule: {str(e)}")
            raise
    
    async def get_by_id(self, schedule_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve interview schedule by ID.
        
        Args:
            schedule_id: Schedule ObjectId as string
            
        Returns:
            Optional[Dict]: Schedule document or None if not found
        """
        try:
            doc = await self.collection.find_one({"_id": ObjectId(schedule_id)})
            return doc
        except Exception as e:
            logger.error(f"Failed to get schedule {schedule_id}: {str(e)}")
            return None
    
    async def get_by_candidate(self, candidate_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve all interview schedules for a candidate.
        
        Args:
            candidate_id: Candidate ID
            
        Returns:
            List[Dict]: List of schedule documents
        """
        try:
            schedules = await self.collection.find(
                {"candidate_id": candidate_id}
            ).to_list(None)
            return schedules
        except Exception as e:
            logger.error(f"Failed to get schedules for candidate {candidate_id}: {str(e)}")
            return []
    
    async def get_by_recruiter(self, recruiter_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve all interview schedules for a recruiter.
        
        Args:
            recruiter_id: Recruiter ID
            
        Returns:
            List[Dict]: List of schedule documents
        """
        try:
            schedules = await self.collection.find(
                {"recruiter_id": recruiter_id}
            ).to_list(None)
            return schedules
        except Exception as e:
            logger.error(f"Failed to get schedules for recruiter {recruiter_id}: {str(e)}")
            return []
    
    async def get_by_job(self, job_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve all interview schedules for a specific job.
        
        Args:
            job_id: Job ID
            
        Returns:
            List[Dict]: List of schedule documents
        """
        try:
            schedules = await self.collection.find(
                {"job_id": job_id}
            ).to_list(None)
            return schedules
        except Exception as e:
            logger.error(f"Failed to get schedules for job {job_id}: {str(e)}")
            return []
    
    async def update(self, schedule_id: str, update_data: Dict[str, Any]) -> bool:
        """
        Update an existing interview schedule.
        
        Args:
            schedule_id: Schedule ObjectId as string
            update_data: Dictionary of fields to update
            
        Returns:
            bool: True if update successful, False otherwise
        """
        try:
            update_data['updated_at'] = datetime.utcnow()
            
            result = await self.collection.update_one(
                {"_id": ObjectId(schedule_id)},
                {"$set": update_data}
            )
            
            if result.modified_count > 0:
                logger.info(f"Updated interview schedule: {schedule_id}")
                return True
            else:
                logger.warning(f"Schedule not found or no changes made: {schedule_id}")
                return False
        except Exception as e:
            logger.error(f"Failed to update schedule {schedule_id}: {str(e)}")
            return False
    
    async def delete(self, schedule_id: str) -> bool:
        """
        Delete an interview schedule (soft delete recommended in production).
        
        Args:
            schedule_id: Schedule ObjectId as string
            
        Returns:
            bool: True if deleted, False otherwise
        """
        try:
            # Soft delete - set status to CANCELLED instead of removing
            result = await self.update(schedule_id, {
                "status": "cancelled"
            })
            return result
        except Exception as e:
            logger.error(f"Failed to delete schedule {schedule_id}: {str(e)}")
            return False
    
    async def get_by_application(self, application_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve interview schedule by application ID.
        
        Args:
            application_id: Application ID
            
        Returns:
            Optional[Dict]: Schedule document or None if not found
        """
        try:
            doc = await self.collection.find_one({"application_id": application_id})
            return doc
        except Exception as e:
            logger.error(f"Failed to get schedule for application {application_id}: {str(e)}")
            return None

    async def get_by_candidate_action_token(self, candidate_action_token: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve interview schedule by candidate action token.

        Args:
            candidate_action_token: Token used in candidate self-service links

        Returns:
            Optional[Dict]: Schedule document or None if not found
        """
        try:
            return await self.collection.find_one({"candidate_action_token": str(candidate_action_token or "")})
        except Exception as e:
            logger.error(
                "Failed to get schedule by candidate action token %s: %s",
                candidate_action_token,
                str(e),
            )
            return None

    async def get_by_recruiter_action_token(self, recruiter_action_token: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve interview schedule by recruiter action token.

        Args:
            recruiter_action_token: Token used in recruiter action links

        Returns:
            Optional[Dict]: Schedule document or None if not found
        """
        try:
            return await self.collection.find_one({"recruiter_action_token": str(recruiter_action_token or "")})
        except Exception as e:
            logger.error(
                "Failed to get schedule by recruiter action token %s: %s",
                recruiter_action_token,
                str(e),
            )
            return None

    async def has_recruiter_conflict(
        self,
        recruiter_id: str,
        start_time_iso: str,
        end_time_iso: str,
        exclude_schedule_id: Optional[str] = None,
    ) -> bool:
        """
        Check if recruiter already has a confirmed/rescheduled interview overlapping a slot.

        Overlap condition:
        existing.start < requested.end AND existing.end > requested.start
        """
        try:
            query: Dict[str, Any] = {
                "recruiter_id": recruiter_id,
                "status": {"$in": ["confirmed", "rescheduled"]},
                "confirmed_slot.start_time": {"$lt": end_time_iso},
                "confirmed_slot.end_time": {"$gt": start_time_iso},
            }

            if exclude_schedule_id:
                query["_id"] = {"$ne": ObjectId(exclude_schedule_id)}

            conflict = await self.collection.find_one(query, {"_id": 1})
            return conflict is not None
        except Exception as e:
            logger.error(
                "Failed to check recruiter conflict for %s (%s - %s): %s",
                recruiter_id,
                start_time_iso,
                end_time_iso,
                str(e),
            )
            # Fail-safe: if conflict check fails unexpectedly, do not silently allow double booking.
            return True
    
    async def get_all_by_status(self, status: str) -> List[Dict[str, Any]]:
        """
        Retrieve all schedules with a specific status.
        
        Args:
            status: Status value to filter by
            
        Returns:
            List[Dict]: List of schedule documents
        """
        try:
            schedules = await self.collection.find(
                {"status": status}
            ).to_list(None)
            return schedules
        except Exception as e:
            logger.error(f"Failed to get schedules by status {status}: {str(e)}")
            return []
