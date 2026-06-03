/**
 * mediaRoute.js
 * Recruiter-only media endpoints for interview recordings.
 *
 * Mounted at: /api/call-rooms  (see index.js)
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────────────────
 *  GET /:roomId/media                   → manifest of all available media
 *  GET /:roomId/media/video             → stream raw recording (Range-capable)
 *  GET /:roomId/media/audio             → stream analysis audio (Range-capable)
 *  GET /:roomId/media/frame/:frameName  → serve a single analysis frame image
 *
 * Security
 * ─────────────────────────────────────────────────────────────────────────────
 *  • verifyToken is required on every endpoint.
 *  • Only the room's initiator (recruiter) may access media.
 *  • All file paths are sanitised with safePath() to prevent traversal.
 *  • Frame names are validated with validateFrameName() before disk access.
 */
'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { spawn } = require('child_process');
const CallRoom = require('../models/CallRoom');
const { verifyToken } = require('../middleware/auth');
const {
  getInterviewMedia,
  getMimeType,
  validateFrameName,
  safePath,
  interviewsUploadsRoot,
} = require('../services/mediaService');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * resolveInterviewId
 * Returns the stable directory name used under uploads/interviews/.
 * Prefers callRoom.roomId if present, otherwise falls back to the Mongo _id.
 *
 * @param {object} callRoom - Mongoose document
 * @returns {string}
 */
function resolveInterviewId(callRoom) {
  return callRoom.roomId || String(callRoom._id);
}

/**
 * findFirstFile
 * Scans `dir` for the first file whose extension (lower-cased) appears in the
 * `extensions` array.  Returns the filename (not the full path), or null.
 *
 * @param {string}   dir        - Absolute directory to scan
 * @param {string[]} extensions - Allowed extensions, e.g. ['.webm', '.mp4']
 * @returns {string|null}
 */
function findFirstFile(dir, extensions) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    if (extensions.includes(path.extname(f).toLowerCase())) return f;
  }
  return null;
}

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
// In-flight remux promises keyed by output path, so concurrent first-load
// requests don't spawn ffmpeg twice for the same recording.
const _remuxInFlight = new Map();

/**
 * ensureSeekableVideo
 * MediaRecorder-produced WebM has duration=Infinity and no Cues, so the browser
 * cannot seek it (currentTime snaps back to 0). Remux once with ffmpeg
 * (stream copy — no re-encode, fast) to write a proper duration + seek cues,
 * cache it next to the raw file, and serve that instead.
 *
 * Returns the seekable file path, or null to fall back to the raw file
 * (ffmpeg missing / non-webm / remux failed).
 *
 * @param {string} videoPath - absolute path to the raw recording
 * @param {string} rawDir    - directory to write the cached seekable file
 * @returns {Promise<string|null>}
 */
function ensureSeekableVideo(videoPath, rawDir) {
  if (path.extname(videoPath).toLowerCase() !== '.webm') return Promise.resolve(null);

  const out = path.join(rawDir, 'recording.seekable.webm');
  try {
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return Promise.resolve(out);
  } catch {
    /* fall through to remux */
  }

  if (_remuxInFlight.has(out)) return _remuxInFlight.get(out);

  const job = new Promise((resolve) => {
    // -c copy: rewrite the container only (adds duration + Cues), no re-encode.
    const ff = spawn(FFMPEG_BIN, ['-y', '-i', videoPath, '-c', 'copy', out], {
      windowsHide: true,
    });
    let stderr = '';
    ff.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    ff.on('error', (err) => {
      console.warn('[mediaRoute] ffmpeg remux unavailable:', err?.message);
      resolve(null); // ffmpeg not found → serve raw
    });
    ff.on('close', (code) => {
      let ok = false;
      try {
        // -c copy output should be ~the same size as the input. A wildly
        // smaller file means the source was broken and the remux is garbage —
        // fall back to the raw file rather than serving a corrupt remux.
        const inSize = fs.statSync(videoPath).size;
        const outSize = fs.existsSync(out) ? fs.statSync(out).size : 0;
        ok = code === 0 && outSize > 0 && outSize >= inSize * 0.5;
      } catch {
        ok = false;
      }
      if (!ok) {
        console.warn('[mediaRoute] ffmpeg remux failed (code %s): %s', code, stderr.slice(-300));
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* ignore */ }
        resolve(null);
      } else {
        resolve(out);
      }
    });
  }).finally(() => _remuxInFlight.delete(out));

  _remuxInFlight.set(out, job);
  return job;
}

/**
 * streamFile
 * Shared helper that handles both plain streaming and HTTP Range requests.
 * Called by the video and audio endpoints.
 *
 * @param {object} res       - Express response
 * @param {string} filePath  - Absolute path to the file on disk
 * @param {string} mimeType  - Content-Type to set
 * @param {string|undefined} rangeHeader - value of req.headers.range
 */
function streamFile(res, filePath, mimeType, rangeHeader) {
  const stat      = fs.statSync(filePath);
  const fileSize  = stat.size;

  // ── Ranged request (for video/audio seeking) ──────────────────────────────
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    // If the end byte is omitted, serve up to 2 MB chunks so the client
    // can start playing quickly without buffering the whole file.
    const end   = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 2 * 1024 * 1024 - 1, fileSize - 1);

    if (start >= fileSize || end >= fileSize || start > end) {
      // 416 Range Not Satisfiable
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206).set({
      'Content-Range'  : `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges'  : 'bytes',
      'Content-Length' : chunkSize,
      'Content-Type'   : mimeType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // ── No Range header: stream the whole file ────────────────────────────────
  res.status(200).set({
    'Content-Type'   : mimeType,
    'Content-Length' : fileSize,
    'Accept-Ranges'  : 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared auth + ownership guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * loadRoomAndCheckOwnership
 * Middleware factory — loads the CallRoom by its Mongo _id and verifies that
 * the authenticated user is the room's initiator (recruiter).
 *
 * Attaches `req.callRoom` on success.
 */
async function loadRoomAndCheckOwnership(req, res, next) {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId).populate('initiator', '_id');
    if (!callRoom) {
      return res.status(404).json({ success: false, message: 'Call room not found.' });
    }

    // Only the recruiter who created the room may access its media.
    if (!callRoom.initiator || !callRoom.initiator._id.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Access denied. Recruiter only.' });
    }

    req.callRoom = callRoom;
    return next();
  } catch (err) {
    console.error('[mediaRoute] loadRoomAndCheckOwnership error:', err?.message);
    return res.status(500).json({ success: false, message: 'Server error while loading room.' });
  }
}

// The route regex `[0-9a-fA-F]{24}` ensures the :roomId segment is always a
// valid Mongo ObjectId hex string — Express returns 404 automatically for
// anything that doesn't match, so no extra validation is needed here.
const ROOM_ID_REGEX = '[0-9a-fA-F]{24}';

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint 1 — GET /:roomId/media
// Returns a JSON manifest of all available media assets for the interview.
// ─────────────────────────────────────────────────────────────────────────────
router.get(`/:roomId(${ROOM_ID_REGEX})/media`, verifyToken, loadRoomAndCheckOwnership, async (req, res) => {
  try {
    const { roomId }    = req.params;
    const callRoom      = req.callRoom;
    const interviewId   = resolveInterviewId(callRoom);
    const media         = getInterviewMedia(interviewId);

    // Build URL prefixes relative to this router's mount point.
    const base = `/api/call-rooms/${roomId}/media`;

    // ── Video ────────────────────────────────────────────────────────────────
    const videoSection = {
      available : media.video.available,
      url       : `${base}/video`,
      filename  : media.video.filename || 'recording.webm',
      sizeMb    : media.video.sizeMb,
    };

    // ── Audio ────────────────────────────────────────────────────────────────
    const audioSection = {
      available : media.audio.available,
      url       : `${base}/audio`,
      filename  : media.audio.filename || 'audio.wav',
      note      : 'Audio may not be available if analysis cleanup ran.',
    };

    // ── Frames ───────────────────────────────────────────────────────────────
    const framesSection = media.frames.map(f => ({
      filename : f.filename,
      url      : `${base}/frame/${encodeURIComponent(f.filename)}`,
      index    : f.index,
    }));

    return res.json({
      available   : media.available,
      interviewId,
      video       : videoSection,
      audio       : audioSection,
      frames      : framesSection,
      frameCount  : framesSection.length,
    });
  } catch (err) {
    console.error('[mediaRoute] /media error:', err?.message);
    return res.status(500).json({ success: false, message: 'Failed to build media manifest.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint 2 — GET /:roomId/media/video
// Streams the raw interview recording with Range-request support.
// ─────────────────────────────────────────────────────────────────────────────
router.get(`/:roomId(${ROOM_ID_REGEX})/media/video`, verifyToken, loadRoomAndCheckOwnership, async (req, res) => {
  try {
    const callRoom    = req.callRoom;
    const interviewId = resolveInterviewId(callRoom);
    const rawDir      = safePath(interviewsUploadsRoot, interviewId, 'raw');

    if (!rawDir) {
      return res.status(400).json({ success: false, message: 'Invalid interview path.' });
    }

    const videoExts  = ['.webm', '.mp4', '.mkv', '.mov'];
    const videoFile  = findFirstFile(rawDir, videoExts);
    if (!videoFile) {
      return res.status(404).json({ success: false, message: 'Video recording not found.' });
    }

    const videoPath = safePath(rawDir, videoFile);
    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(404).json({ success: false, message: 'Video file not accessible.' });
    }

    // Serve a seekable remux when possible so "Watch Answer" / timeline jumps
    // land on the right moment instead of snapping to 0 (raw MediaRecorder
    // WebM is not seekable). Falls back to the raw file if ffmpeg is absent.
    let servePath = videoPath;
    try {
      const seekable = await ensureSeekableVideo(videoPath, rawDir);
      if (seekable) servePath = seekable;
    } catch (remuxErr) {
      console.warn('[mediaRoute] seekable remux skipped:', remuxErr?.message);
    }

    const mimeType = getMimeType(servePath);
    streamFile(res, servePath, mimeType, req.headers.range);
  } catch (err) {
    console.error('[mediaRoute] /media/video error:', err?.message);
    return res.status(500).json({ success: false, message: 'Failed to stream video.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint 3 — GET /:roomId/media/audio
// Streams the analysis audio (audio.wav) with Range-request support.
// Returns a 404-equivalent JSON body if the file was cleaned up after analysis.
// ─────────────────────────────────────────────────────────────────────────────
router.get(`/:roomId(${ROOM_ID_REGEX})/media/audio`, verifyToken, loadRoomAndCheckOwnership, async (req, res) => {
  try {
    const callRoom    = req.callRoom;
    const interviewId = resolveInterviewId(callRoom);
    const audioPath   = safePath(interviewsUploadsRoot, interviewId, 'analysis', 'audio.wav');

    if (!audioPath) {
      return res.status(400).json({ success: false, message: 'Invalid interview path.' });
    }

    if (!fs.existsSync(audioPath)) {
      // Audio is expected to be absent after analysis cleanup — return a
      // structured 200 response rather than a raw 404 so frontends can
      // distinguish "cleaned up" from "wrong URL".
      return res.status(200).json({
        available : false,
        message   : 'Audio not available. It may have been cleaned up after analysis.',
      });
    }

    streamFile(res, audioPath, 'audio/wav', req.headers.range);
  } catch (err) {
    console.error('[mediaRoute] /media/audio error:', err?.message);
    return res.status(500).json({ success: false, message: 'Failed to stream audio.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint 4 — GET /:roomId/media/frame/:frameName
// Serves a single analysis frame image.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  `/:roomId(${ROOM_ID_REGEX})/media/frame/:frameName`,
  verifyToken,
  loadRoomAndCheckOwnership,
  async (req, res) => {
    try {
      const { frameName } = req.params;
      const callRoom      = req.callRoom;
      const interviewId   = resolveInterviewId(callRoom);

      // ── Sanitise the frame name ─────────────────────────────────────────────
      // validateFrameName checks for '..' / '/' / '\' / bad chars / bad extension.
      if (!validateFrameName(frameName)) {
        return res.status(400).json({
          success : false,
          message : 'Invalid frame name. Only image filenames with safe characters are allowed.',
        });
      }

      // ── Build and verify the file path ──────────────────────────────────────
      const framePath = safePath(
        interviewsUploadsRoot,
        interviewId,
        'analysis',
        'frames',
        frameName,
      );

      if (!framePath) {
        return res.status(400).json({ success: false, message: 'Path traversal detected.' });
      }

      // Belt-and-suspenders: assert the resolved path is still inside our root.
      if (!framePath.startsWith(path.resolve(interviewsUploadsRoot))) {
        return res.status(400).json({ success: false, message: 'Path traversal detected.' });
      }

      if (!fs.existsSync(framePath)) {
        return res.status(404).json({ success: false, message: `Frame '${frameName}' not found.` });
      }

      // ── Stream the image ────────────────────────────────────────────────────
      const mimeType = getMimeType(framePath);
      const stat     = fs.statSync(framePath);
      res.status(200).set({
        'Content-Type'   : mimeType,
        'Content-Length' : stat.size,
        'Cache-Control'  : 'private, max-age=3600',
      });
      fs.createReadStream(framePath).pipe(res);
    } catch (err) {
      console.error('[mediaRoute] /media/frame error:', err?.message);
      return res.status(500).json({ success: false, message: 'Failed to serve frame image.' });
    }
  },
);

module.exports = router;
