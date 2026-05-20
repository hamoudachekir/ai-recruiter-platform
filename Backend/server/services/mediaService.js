/**
 * mediaService.js
 * Helper for interview media file resolution.
 */
'use strict';

const path = require('path');
const fs   = require('fs');

// Mirrors the same root used by callRoom.js and the analysis service.
const interviewsUploadsRoot = path.resolve(__dirname, '../../uploads/interviews');

const VIDEO_EXTENSIONS = ['.webm', '.mp4', '.mkv', '.mov'];
const FRAME_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

const MIME_TYPES = {
  '.webm' : 'video/webm',
  '.mp4'  : 'video/mp4',
  '.mkv'  : 'video/x-matroska',
  '.mov'  : 'video/quicktime',
  '.wav'  : 'audio/wav',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.png'  : 'image/png',
};

// ─────────────────────────────────────────────────────────────────────────────
// getInterviewMedia
// Returns a structured descriptor of all media assets for a given interviewId.
// ─────────────────────────────────────────────────────────────────────────────
function getInterviewMedia(interviewId) {
  const interviewDir = path.join(interviewsUploadsRoot, String(interviewId));
  const rawDir       = path.join(interviewDir, 'raw');
  const analysisDir  = path.join(interviewDir, 'analysis');
  const framesDir    = path.join(analysisDir, 'frames');

  // ── Video ──────────────────────────────────────────────────────────────────
  let videoFile      = null;
  let videoAvailable = false;
  let videoSizeMb    = 0;

  if (fs.existsSync(rawDir)) {
    const rawFiles = fs.readdirSync(rawDir);
    for (const f of rawFiles) {
      const ext = path.extname(f).toLowerCase();
      if (VIDEO_EXTENSIONS.includes(ext)) {
        videoFile = f;
        const stat = fs.statSync(path.join(rawDir, f));
        videoSizeMb    = parseFloat((stat.size / (1024 * 1024)).toFixed(2));
        videoAvailable = true;
        break;
      }
    }
  }

  // ── Audio ──────────────────────────────────────────────────────────────────
  const audioPath      = path.join(analysisDir, 'audio.wav');
  const audioAvailable = fs.existsSync(audioPath);

  // ── Frames ─────────────────────────────────────────────────────────────────
  let frames = [];
  if (fs.existsSync(framesDir)) {
    const frameFiles = fs
      .readdirSync(framesDir)
      .filter(f => FRAME_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .sort()
      .slice(0, 50); // hard cap at 50 to keep the JSON response lightweight

    frames = frameFiles.map((f, i) => ({
      filename : f,
      index    : i + 1,
    }));
  }

  return {
    available   : videoAvailable || audioAvailable || frames.length > 0,
    interviewId : String(interviewId),
    rawDir,
    analysisDir,
    framesDir,
    video: {
      available    : videoAvailable,
      filename     : videoFile,
      sizeMb       : videoSizeMb,
      absolutePath : videoFile ? path.join(rawDir, videoFile) : null,
    },
    audio: {
      available    : audioAvailable,
      filename     : audioAvailable ? 'audio.wav' : null,
      absolutePath : audioAvailable ? audioPath : null,
    },
    frames,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getMimeType
// Returns the MIME type for a file path based on its extension.
// Falls back to 'application/octet-stream' for unknown extensions.
// ─────────────────────────────────────────────────────────────────────────────
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// validateFrameName
// Returns true iff the supplied name is safe to serve as a frame file.
// Rejects names that contain path traversal sequences or disallowed characters,
// and rejects files whose extension is not in FRAME_EXTENSIONS.
// ─────────────────────────────────────────────────────────────────────────────
function validateFrameName(name) {
  if (!name) return false;
  // Reject traversal attempts and path separators
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  // Allow only safe filename characters
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(name)) return false;
  const ext = path.extname(name).toLowerCase();
  return FRAME_EXTENSIONS.includes(ext);
}

// ─────────────────────────────────────────────────────────────────────────────
// safePath
// Joins base + parts with path.join, then asserts the result is still inside
// base (path traversal protection).  Returns null if the check fails.
// ─────────────────────────────────────────────────────────────────────────────
function safePath(base, ...parts) {
  const resolved = path.resolve(base);
  const joined   = path.join(resolved, ...parts);
  if (!joined.startsWith(resolved)) return null;
  return joined;
}

module.exports = {
  getInterviewMedia,
  getMimeType,
  validateFrameName,
  safePath,
  interviewsUploadsRoot,
  MIME_TYPES,
  VIDEO_EXTENSIONS,
  FRAME_EXTENSIONS,
};
