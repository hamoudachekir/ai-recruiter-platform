import logging
from typing import List, Optional, Dict, Any
from datetime import datetime
from bson import ObjectId
from pymongo.errors import PyMongoError

logger = logging.getLogger(__name__)


class ScheduleLogRepository:
    """
    Repository for managing schedule log documents in MongoDB.
    Provides audit trail for all scheduling decisions and actions.
    """
    
    def __init__(self, db):
        """
        Initialize repository with MongoDB database instance.
        
        Args:
            db: MongoDB database instance
        """
        self.db = db
        self.collection_name = "schedule_logs"
        self.collection = db[self.collection_name]
    
    async def log_action(
        self,
        interview_schedule_id: str,
        action: str,
        details: Optional[Dict[str, Any]] = None,
        user_id: Optional[str] = None
    ) -> str:
        """
        Create a new log entry for a scheduling action.
        
        Args:
            interview_schedule_id: ID of the interview schedule
            action: Name of the action (e.g., "scheduling_started", "slot_confirmed")
            details: Optional dictionary with action-specific details
            user_id: Optional ID of user performing the action
            
        Returns:
            str: ID of created log document
            
        Raises:
            PyMongoError: If database operation fails
        """
        try:
            log_data = {
                "interview_schedule_id": interview_schedule_id,
                "action": action,
                "details": details or {},
                "user_id": user_id,
                "created_at": datetime.utcnow()
            }
            
            result = await self.collection.insert_one(log_data)
            logger.info(
                f"Logged action '{action}' for schedule {interview_schedule_id}: {result.inserted_id}"
            )
            return str(result.inserted_id)
        except PyMongoError as e:
            logger.error(f"Failed to create log entry: {str(e)}")
            raise
    
    async def get_by_id(self, log_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a specific log entry.
        
        Args:
            log_id: Log ObjectId as string
            
        Returns:
            Optional[Dict]: Log document or None if not found
        """
        try:
            doc = await self.collection.find_one({"_id": ObjectId(log_id)})
            return doc
        except Exception as e:
            logger.error(f"Failed to get log {log_id}: {str(e)}")
            return None
    
    async def get_by_schedule_id(self, interview_schedule_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve all logs for a specific interview schedule.
        Useful for audit trail.
        
        Args:
            interview_schedule_id: Schedule ID
            
        Returns:
            List[Dict]: List of log documents, ordered by creation time
        """
        try:
            logs = await self.collection.find(
                {"interview_schedule_id": interview_schedule_id}
            ).sort("created_at", 1).to_list(None)
            return logs
        except Exception as e:
            logger.error(f"Failed to get logs for schedule {interview_schedule_id}: {str(e)}")
            return []
    
    async def get_by_action(self, action: str, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Retrieve recent logs for a specific action type.
        
        Args:
            action: Action name to filter by
            limit: Maximum number of results
            
        Returns:
            List[Dict]: List of log documents
        """
        try:
            logs = await self.collection.find(
                {"action": action}
            ).sort("created_at", -1).limit(limit).to_list(None)
            return logs
        except Exception as e:
            logger.error(f"Failed to get logs for action {action}: {str(e)}")
            return []
    
    async def get_by_time_range(
        self,
        start_time: datetime,
        end_time: datetime,
        limit: int = 1000
    ) -> List[Dict[str, Any]]:
        """
        Retrieve logs within a specific time range.
        
        Args:
            start_time: Start datetime
            end_time: End datetime
            limit: Maximum number of results
            
        Returns:
            List[Dict]: List of log documents
        """
        try:
            logs = await self.collection.find(
                {
                    "created_at": {
                        "$gte": start_time,
                        "$lte": end_time
                    }
                }
            ).sort("created_at", -1).limit(limit).to_list(None)
            return logs
        except Exception as e:
            logger.error(f"Failed to get logs in time range: {str(e)}")
            return []
    
    async def get_failed_actions(self, limit: int = 100) -> List[Dict[str, Any]]:
        """
        Retrieve all failed actions (email_failed, calendar_error, etc.).
        Useful for monitoring and debugging.
        
        Args:
            limit: Maximum number of results
            
        Returns:
            List[Dict]: List of failed action logs
        """
        try:
            logs = await self.collection.find(
                {"action": {"$in": ["email_failed", "calendar_error"]}}
            ).sort("created_at", -1).limit(limit).to_list(None)
            return logs
        except Exception as e:
            logger.error(f"Failed to get failed actions: {str(e)}")
            return []
    
    async def get_schedule_audit_trail(self, interview_schedule_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve complete audit trail for a schedule.
        Includes all actions with chronological order and details.
        
        Args:
            interview_schedule_id: Schedule ID
            
        Returns:
            List[Dict]: Complete audit trail
        """
        return await self.get_by_schedule_id(interview_schedule_id)
    
    async def count_by_action(self, action: str) -> int:
        """
        Count total occurrences of a specific action.
        
        Args:
            action: Action name
            
        Returns:
            int: Count of occurrences
        """
        try:
            count = await self.collection.count_documents({"action": action})
            return count
        except Exception as e:
            logger.error(f"Failed to count logs for action {action}: {str(e)}")
            return 0
    
    async def delete_old_logs(self, days_to_keep: int = 90) -> int:
        """
        Delete logs older than specified number of days.
        Useful for maintenance and storage management.
        
        Args:
            days_to_keep: Number of days of logs to retain
            
        Returns:
            int: Number of documents deleted
        """
        try:
            cutoff_date = datetime.utcnow()
            cutoff_date = cutoff_date.replace(
                day=cutoff_date.day - days_to_keep
            )
            
            result = await self.collection.delete_many(
                {"created_at": {"$lt": cutoff_date}}
            )
            
            logger.info(f"Deleted {result.deleted_count} logs older than {days_to_keep} days")
            return result.deleted_count
        except Exception as e:
            logger.error(f"Failed to delete old logs: {str(e)}")
            return 0
