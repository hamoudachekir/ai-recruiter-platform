/**
 * Candidate Comparison Service — NVIDIA NIM / Meta Llama 3.3 70B edition
 *
 * Uses NVIDIA's OpenAI-compatible inference API (no external SDK needed).
 * Native fetch (Node 18+) calls https://integrate.api.nvidia.com/v1/chat/completions.
 *
 * To switch models later, set COMPARISON_LLM_MODEL in Backend/server/.env:
 *   COMPARISON_LLM_MODEL=deepseek-ai/deepseek-r1
 *   COMPARISON_LLM_MODEL=qwen/qwen2.5-72b-instruct
 *   COMPARISON_LLM_MODEL=mistralai/mixtral-8x22b-instruct-v0.1
 */

const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL    = process.env.COMPARISON_LLM_MODEL || "meta/llama-3.3-70b-instruct";
const REQUEST_TIMEOUT = parseInt(process.env.COMPARISON_TIMEOUT_MS || "90000", 10);
const CACHE_TTL_MS    = 3600 * 1000; // 1 hour

// ─── In-memory cache ──────────────────────────────────────────────────────────

const _cache = new Map();

function _cacheKey(jobId, sessionIds) {
  return `${jobId}:${[...sessionIds].sort().join(",")}`;
}
function _fromCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}
function _toCache(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert HR analytics engine for TALAN Tunisie Consulting.
You receive structured interview data for multiple candidates who applied for the same job.

Your task:
1. Compare candidates objectively across psychometric and behavioral dimensions.
2. Identify each candidate's top 3 strengths and top 2 development gaps.
3. Compute a composite match_score (0-100) per candidate using this formula:
     technical_accuracy × 0.25
     + theta_normalized × 0.20     (theta mapped 0-100: (theta+3)/6×100)
     + resilience_score × 0.15
     + system_design × 0.15        (infer: technicalScore×0.6 + answerCompleteness×0.4)
     + problem_solving × 0.10      (infer: theta_normalized×0.5 + resilience×0.3 + completeness×0.2)
     + communication × 0.10        ((sentimentScore+1)/2×100×0.5 + answerCompleteness×0.5)
     + hr_fit × 0.05               (use hr_score directly)
4. Pick ONE recommended candidate with confidence_pct and justification.
5. Write a head-to-head narrative_comparison and executive_summary for the recruiter.

RULES:
- Never invent numbers. Base every claim on the data provided.
- If top two composite scores differ < 5, set close_call=true and add tiebreaker_question.
- Be professional and bias-free. Do not reference universities or gender.
- In ALL text fields (narrative_comparison, executive_summary, justification, strongest_point,
  main_weakness): ALWAYS refer to candidates by their candidate_name. NEVER use session_id
  values or any hex/ObjectId strings in text fields.
- Output ONLY valid JSON. No markdown, no backticks, no preamble, no trailing text.

Required JSON schema (fill ALL fields):
{
  "recommended_candidate_id": "<session_id>",
  "confidence_pct": 87,
  "close_call": false,
  "tiebreaker_question": null,
  "justification": "...",
  "narrative_comparison": "...",
  "executive_summary": "...",
  "rankings": [
    {
      "session_id": "<session_id>",
      "rank": 1,
      "suitability_score": 84,
      "composite_score": 82,
      "composite_breakdown": {
        "technical": 84,
        "theta_normalized": 78,
        "resilience": 91,
        "system_design": 88,
        "problem_solving": 75,
        "communication": 65,
        "hr_fit": 80
      },
      "match_score": 84,
      "strengths": ["strength 1", "strength 2", "strength 3"],
      "gaps": ["gap 1", "gap 2"],
      "strongest_point": "one sentence",
      "main_weakness": "one sentence",
      "hiring_recommendation": "Strongly Recommend",
      "justification": "..."
    }
  ]
}`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function _buildUserMessage(job, candidates) {
  const blocks = candidates.map((c) => {
    const m = c.metrics || {};
    const n  = (v, d = "N/A") => v != null && !Number.isNaN(Number(v)) ? Number(v).toFixed(2) : d;
    const ni = (v, d = "N/A") => v != null && !Number.isNaN(Number(v)) ? String(Math.round(Number(v))) : d;
    return {
      session_id:          c.sessionId,  // use only in rankings[].session_id — NOT in text
      candidate_name:      c.candidateName,  // use this name in ALL text fields
      technical_theta:     n(m.technicalTheta),
      technical_score:     ni(m.technicalScore),
      hr_score:            ni(m.hrScore),
      integrity_score:     ni(m.integrityScore),
      resilience_index:    ni(m.resilienceIndex),
      sentiment_score:     n(m.sentimentScore),
      answer_completeness: ni(m.answerCompleteness),
      stress_profile:      m.stressProfile || "unknown",
      summary:             (m.summary || "").slice(0, 400),
      strengths_notes:     Array.isArray(m.strengths) ? m.strengths.slice(0, 3) : [],
      weaknesses_notes:    Array.isArray(m.weaknesses) ? m.weaknesses.slice(0, 2) : [],
    };
  });

  return JSON.stringify({
    job: {
      title:           job.title || "",
      description:     (job.description || "").slice(0, 500),
      required_skills: job.skills || [],
      languages:       job.languages || [],
    },
    candidates: blocks,
  }, null, 2);
}

// ─── JSON extraction (handles fences, leading text, truncation) ───────────────

function _extractJSON(raw) {
  let text = raw.trim();

  // Strip ```json ... ``` or ``` ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find outermost JSON object boundaries
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  try {
    return JSON.parse(text);
  } catch {
    // Attempt to repair a truncated JSON by closing open structures
    const repaired = _repairTruncatedJSON(text);
    return JSON.parse(repaired);
  }
}

function _repairTruncatedJSON(text) {
  // Count open brackets/braces and close them
  let open = 0;
  let inStr = false;
  let escape = false;

  for (const ch of text) {
    if (escape)          { escape = false; continue; }
    if (ch === "\\" && inStr) { escape = true; continue; }
    if (ch === '"')      { inStr = !inStr; continue; }
    if (inStr)           continue;
    if (ch === "{" || ch === "[") open++;
    if (ch === "}" || ch === "]") open--;
  }

  // Close any unclosed string first, then close objects
  let repaired = text.trimEnd();
  if (inStr) repaired += '"';
  while (open > 0) {
    repaired += "}";
    open--;
  }
  return repaired;
}

// ─── NVIDIA API call ──────────────────────────────────────────────────────────

async function _callNvidia(userMessage) {
  const apiKey = process.env.COMPARISON_NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY not configured. Add COMPARISON_NVIDIA_API_KEY to Backend/server/.env"
    );
  }

  const response = await fetch(NVIDIA_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:       NVIDIA_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userMessage   },
      ],
      temperature: 0.2,
      top_p:       0.7,
      max_tokens:  4096,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`NVIDIA API ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("NVIDIA returned empty content");

  console.log(`[comparison] NVIDIA raw length: ${raw.length} chars`);
  return raw;
}

// ─── Deterministic fallback ───────────────────────────────────────────────────
// Used when the NVIDIA API is unavailable. Scores are computed purely from
// the numeric metrics — no LLM involved.

function _deterministicFallback(candidates) {
  const scored = candidates.map((c) => {
    const m = c.metrics || {};
    const num = (v, def = 50) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : def);

    const tech    = num(m.technicalScore, 50);
    const theta   = Math.min(100, Math.max(0, ((num(m.technicalTheta, 0) + 3) / 6) * 100));
    const res     = num(m.resilienceIndex, 50);
    const comp    = num(m.answerCompleteness, 50);
    const hr      = num(m.hrScore, 50);
    const sent    = Math.min(100, Math.max(0, ((num(m.sentimentScore, 0) + 1) / 2) * 100));

    const sysDesign    = tech * 0.6  + comp * 0.4;
    const problemSolve = theta * 0.5 + res * 0.3 + comp * 0.2;
    const communication = sent * 0.5  + comp * 0.5;

    const composite = Math.round(
      tech * 0.25 + theta * 0.20 + res * 0.15 + sysDesign * 0.15 +
      problemSolve * 0.10 + communication * 0.10 + hr * 0.05
    );

    return {
      session_id:   String(c.sessionId),
      name:         c.candidateName,
      composite,
      breakdown: {
        technical:       Math.round(tech),
        theta_normalized: Math.round(theta),
        resilience:      Math.round(res),
        system_design:   Math.round(sysDesign),
        problem_solving: Math.round(problemSolve),
        communication:   Math.round(communication),
        hr_fit:          Math.round(hr),
      },
    };
  });

  scored.sort((a, b) => b.composite - a.composite);

  const gap = scored.length >= 2 ? scored[0].composite - scored[1].composite : 99;

  return {
    recommended_candidate_id: scored[0].session_id,
    confidence_pct:           Math.min(95, 60 + Math.round(gap * 0.7)),
    close_call:                gap < 5,
    tiebreaker_question:       gap < 5 ? "Can you walk us through a system you designed under time pressure?" : null,
    justification:             `Deterministic ranking based on interview metrics. ${scored[0].name} leads with composite score ${scored[0].composite}.`,
    narrative_comparison:      scored.map((s, i) => `${i + 1}. ${s.name} — composite ${s.composite}`).join(" | "),
    executive_summary:         `Fallback ranking (NVIDIA API unavailable). Top candidate: ${scored[0].name} (${scored[0].composite}/100).`,
    rankings: scored.map((s, i) => ({
      session_id:           s.session_id,
      rank:                 i + 1,
      suitability_score:    s.composite,
      composite_score:      s.composite,
      composite_breakdown:  s.breakdown,
      match_score:          s.composite,
      strengths:            ["See individual interview report"],
      gaps:                 ["See individual interview report"],
      strongest_point:      "Ranked by composite metric score",
      main_weakness:        "Full AI analysis unavailable",
      hiring_recommendation: i === 0 ? "Recommend" : i === 1 ? "Consider" : "Do Not Recommend",
      justification:        `Composite score: ${s.composite}/100`,
    })),
    provider: "deterministic/fallback",
  };
}

// ─── Post-process: replace session IDs with candidate names in all text fields ─
// The LLM sometimes uses session_id values (or hallucinated variants) in free-
// text fields instead of the candidate's actual name. This runs server-side so
// the data stored in MongoDB is always clean.

function _replaceIdsWithNames(text, idToName) {
  if (!text || !Object.keys(idToName).length) return text;
  let out = String(text);
  // 1. Exact replacement
  for (const [id, name] of Object.entries(idToName)) {
    out = out.split(id).join(name);
  }
  // 2. Regex fallback: catch hallucinated IDs (wrong length / extra zeros)
  //    Matches any 16+ char hex string and maps it by suffix overlap
  out = out.replace(/\b[0-9a-f]{16,}\b/gi, (match) => {
    const m = match.toLowerCase();
    for (const [id, name] of Object.entries(idToName)) {
      const i = id.toLowerCase();
      // Same first 4 chars (e.g. "feed") + same last 2 chars (e.g. "c1")
      if (i.slice(0, 4) === m.slice(0, 4) && i.slice(-2) === m.slice(-2)) return name;
    }
    return match;
  });
  return out;
}

function _cleanTextFields(result, candidates) {
  // Build id → name map from the candidates array passed to compareAndRank
  const idToName = {};
  candidates.forEach((c) => {
    if (c.sessionId && c.candidateName) {
      idToName[String(c.sessionId)] = c.candidateName;
    }
  });
  if (!Object.keys(idToName).length) return result;

  const clean = (t) => _replaceIdsWithNames(t, idToName);

  return {
    ...result,
    executive_summary:      clean(result.executive_summary),
    executiveSummary:       clean(result.executiveSummary),
    narrative_comparison:   clean(result.narrative_comparison),
    narrativeComparison:    clean(result.narrativeComparison),
    justification:          clean(result.justification),
    rankings: (result.rankings || []).map((r) => ({
      ...r,
      justification:   clean(r.justification),
      strongest_point: clean(r.strongest_point),
      main_weakness:   clean(r.main_weakness),
    })),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Rank and compare interview candidates using NVIDIA Llama 3.3 70B.
 *
 * @param {object}  opts
 * @param {string}  opts.jobId      MongoDB ObjectId string (cache key)
 * @param {object}  opts.job        { title, description, skills, languages }
 * @param {Array}   opts.candidates [{ sessionId, candidateName, metrics }]
 * @param {boolean} [opts.useCache=true]
 * @returns {Promise<object>}
 */
async function compareAndRank({ jobId, job, candidates, useCache = true }) {
  const sessionIds = candidates.map((c) => c.sessionId);
  const cacheKey   = jobId ? _cacheKey(String(jobId), sessionIds) : null;

  if (useCache && cacheKey) {
    const cached = _fromCache(cacheKey);
    if (cached) {
      console.log("[comparison] cache hit:", cacheKey);
      return cached;
    }
  }

  const baseMessage = _buildUserMessage(job, candidates);
  let result = null;

  // Two attempts: second adds a stricter JSON reminder
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = attempt === 0
      ? baseMessage
      : baseMessage + "\n\nIMPORTANT: Output ONLY the raw JSON object. No markdown. No explanation. Start with { and end with }.";

    try {
      console.log(`[comparison] NVIDIA call attempt ${attempt + 1}, model: ${NVIDIA_MODEL}`);

      const raw = await _callNvidia(msg);

      result = _extractJSON(raw);

      if (!Array.isArray(result.rankings) || result.rankings.length === 0) {
        throw new Error("Response missing rankings array");
      }

      console.log(`[comparison] success — ${result.rankings.length} candidates ranked`);
      break;

    } catch (err) {
      if (err instanceof SyntaxError && attempt === 0) {
        console.warn("[comparison] JSON parse error on attempt 1, retrying with stricter prompt…");
        continue;
      }
      console.error(`[comparison] failed (attempt ${attempt + 1}): ${err.message}`);

      if (attempt === 1) {
        // Both attempts failed — use deterministic fallback
        console.warn("[comparison] falling back to deterministic scoring");
        result = _deterministicFallback(candidates);
      }
    }
  }

  if (!result) {
    result = _deterministicFallback(candidates);
  }

  // Stamp provider if not already set
  if (!result.provider) {
    result = { ...result, provider: `nvidia/${NVIDIA_MODEL}` };
  }

  // Replace any session IDs / hallucinated hex strings in text fields with real names
  result = _cleanTextFields(result, candidates);

  if (useCache && cacheKey) _toCache(cacheKey, result);
  return result;
}

function clearCache() { _cache.clear(); }

module.exports = { compareAndRank, clearCache };
