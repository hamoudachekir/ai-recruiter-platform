const fetch = require('node-fetch');

const SUPPORTED_PROVIDERS = new Set(['openai', 'gemini']);
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

const OBJECTIVE_PROMPT = `You are assisting a recruiter reviewing an interview monitoring snapshot.
Describe only objective visual facts.
Do not identify the person.
Do not infer emotion, personality, honesty, race, gender, age, disability, or mental state.
Check only:
- whether one person or multiple people are visible
- whether the face is visible
- whether the camera appears blocked
- whether the frame quality is poor
- whether there are visible signs that require recruiter review

Return JSON only:
{
  "visiblePersons": "none | one | multiple | unclear",
  "faceVisible": true,
  "cameraBlocked": false,
  "frameQuality": "good | medium | poor",
  "objectiveObservations": [],
  "needsRecruiterReview": true,
  "confidence": 0.0
}`;

const normalizeProvider = () => {
  const provider = String(process.env.VISION_LLM_PROVIDER || 'disabled').trim().toLowerCase();
  return SUPPORTED_PROVIDERS.has(provider) ? provider : 'disabled';
};

const getVisionModelName = (provider = normalizeProvider()) => {
  if (provider === 'gemini') {
    return process.env.VISION_LLM_MODEL || process.env.VISION_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  }

  if (provider === 'openai') {
    return process.env.VISION_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  }

  return process.env.VISION_LLM_MODEL || DEFAULT_GEMINI_MODEL;
};

const hasApiKey = (provider = normalizeProvider()) => {
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return false;
};

const sanitizeLLMError = (error) => {
  let message = String(error?.message || 'Vision LLM request failed');
  const secrets = [process.env.GEMINI_API_KEY, process.env.OPENAI_API_KEY].filter(Boolean);

  for (const secret of secrets) {
    message = message.split(secret).join('<redacted>');
  }

  return message
    .replace(/key=([^&\s]+)/gi, 'key=<redacted>')
    .replace(/Bearer\s+([^\s]+)/gi, 'Bearer <redacted>');
};

const getVisionLLMConfig = () => {
  const provider = normalizeProvider();

  return {
    provider,
    model: getVisionModelName(provider),
    apiKeyLoaded: hasApiKey(provider),
  };
};

const extractJsonText = (value) => {
  if (!value) throw new Error('Vision LLM returned an empty response');
  if (typeof value === 'object') return value;

  const cleaned = String(value)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : cleaned;
};

const parseJsonStrict = (value) => {
  const jsonText = extractJsonText(value);
  if (typeof jsonText === 'object') return jsonText;

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error('Vision LLM returned invalid JSON');
  }
};

const coerceBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const normalizeVisionAnalysis = (analysis) => {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('Vision LLM returned an invalid JSON object');
  }

  const visiblePersonsValues = new Set(['none', 'one', 'multiple', 'unclear']);
  const frameQualityValues = new Set(['good', 'medium', 'poor']);
  const visiblePersons = String(analysis.visiblePersons || 'unclear').trim().toLowerCase();
  const frameQuality = String(analysis.frameQuality || 'medium').trim().toLowerCase();
  const confidence = Number(analysis.confidence);

  return {
    visiblePersons: visiblePersonsValues.has(visiblePersons) ? visiblePersons : 'unclear',
    faceVisible: coerceBoolean(analysis.faceVisible, false),
    cameraBlocked: coerceBoolean(analysis.cameraBlocked, false),
    frameQuality: frameQualityValues.has(frameQuality) ? frameQuality : 'medium',
    objectiveObservations: Array.isArray(analysis.objectiveObservations)
      ? analysis.objectiveObservations.map((item) => String(item)).filter(Boolean).slice(0, 8)
      : [],
    needsRecruiterReview: coerceBoolean(analysis.needsRecruiterReview, false),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
  };
};

const normalizeDataUrl = (snapshotBase64 = '') => {
  const raw = String(snapshotBase64 || '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:image/')) return raw;
  return `data:image/jpeg;base64,${raw}`;
};

async function analyzeWithOpenAI(snapshotBase64, model = getVisionModelName('openai')) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: OBJECTIVE_PROMPT },
            { type: 'image_url', image_url: { url: normalizeDataUrl(snapshotBase64) } },
          ],
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI vision request failed (${response.status})`);
  }

  return normalizeVisionAnalysis(parseJsonStrict(data?.choices?.[0]?.message?.content));
}

async function analyzeWithGemini(snapshotBase64, model = getVisionModelName('gemini')) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const normalized = normalizeDataUrl(snapshotBase64);
  const [, meta = '', payload = ''] = normalized.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/) || [];
  if (!payload) throw new Error('Invalid snapshot payload');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
      contents: [
        {
          parts: [
            { text: OBJECTIVE_PROMPT },
            { inlineData: { mimeType: meta || 'image/jpeg', data: payload } },
          ],
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini vision request failed (${response.status})`);
  }

  return normalizeVisionAnalysis(parseJsonStrict(data?.candidates?.[0]?.content?.parts?.[0]?.text));
}

async function analyzeSnapshot(snapshotBase64) {
  const provider = normalizeProvider();
  const model = getVisionModelName(provider);

  if (!snapshotBase64) {
    return { provider, model, skipped: true, reason: 'No snapshot provided' };
  }

  if (provider === 'disabled') {
    return { provider, model, skipped: true, reason: 'Vision LLM disabled' };
  }

  if (!hasApiKey(provider)) {
    return { provider, model, skipped: true, reason: `${provider} API key is not configured` };
  }

  try {
    const result = provider === 'gemini'
      ? await analyzeWithGemini(snapshotBase64, model)
      : await analyzeWithOpenAI(snapshotBase64, model);

    return {
      provider,
      model,
      skipped: false,
      ...result,
    };
  } catch (error) {
    return {
      provider,
      model,
      skipped: true,
      error: sanitizeLLMError(error),
    };
  }
}

module.exports = {
  analyzeSnapshot,
  getVisionLLMConfig,
  getVisionModelName,
  OBJECTIVE_PROMPT,
};
