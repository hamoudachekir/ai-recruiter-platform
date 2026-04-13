const mongoose = require('mongoose');

const callRoomSchema = new mongoose.Schema({
  // Room identification
  roomId: { type: String, unique: true, required: true, index: true },
  
  // Initiator (RH/Enterprise)
  initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  initiatorRole: { type: String, enum: ['rh', 'enterprise'], default: 'rh' },
  
  // Candidate
  candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Job reference (optional)
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  
  // Room status flow
  status: { 
    type: String, 
    enum: ['waiting_confirmation', 'active', 'ended', 'rejected'], 
    default: 'waiting_confirmation',
    index: true
  },
  
  // Candidate join request tracking
  candidateJoinRequestedAt: Date,
  candidateJoinConfirmedAt: Date,
  
  // Recording timeline
  recordingStartedAt: Date,
  recordingEndedAt: Date,
  
  // Transcription & sentiment data
  transcription: {
    text: { type: String, default: '' },
    segments: [{
      text: String,
      sentiment: {
        label: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], default: 'NEUTRAL' },
        score: Number
      },
      timestamp: Date
    }],
    overallSentiment: {
      label: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], default: 'NEUTRAL' },
      score: Number
    }
  },
  
  // Files
  recordingUrl: String,
  transcriptUrl: String,
  
  // Notes
  rhNotes: String,
  
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.models.CallRoom || mongoose.model('CallRoom', callRoomSchema);
