const DEFAULT_MISTRAL_API_URL = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_CORRECTION_MODEL = process.env.VOICE_CORRECTION_MODEL || process.env.MISTRAL_MODEL || 'ministral-8b-latest';
const DEFAULT_SUMMARY_MODEL = process.env.VOICE_SUMMARY_MODEL || process.env.MISTRAL_MODEL || 'ministral-8b-latest';

const POSITIVE_TOKENS = [
  'good', 'great', 'excellent', 'amazing', 'happy', 'love', 'confident', 'strong', 'progress', 'success',
  'greatly', 'perfect', 'positive', 'improved', 'thank you', 'thanks',
  'bon', 'bien', 'excellent', 'formidable', 'heureux', 'aime', 'confiant', 'fort', 'progres', 'succes', 'merci',
];

const NEGATIVE_TOKENS = [
  'bad', 'poor', 'difficult', 'hard', 'problem', 'issue', 'error', 'fail', 'failure', 'stressed',
  'worried', 'negative', 'weak', 'blocked',
  'mauvais', 'difficile', 'probleme', 'erreur', 'echec', 'stresse', 'inquiet', 'negatif', 'faible', 'bloque',
];

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const localCleanTranscriptionText = (text, language = 'en') => {
  const normalized = normalizeWhitespace(text)
    .replace(/(^|\s)description(\.|,|\s|$)/gi, ' ')
    .replace(/\b(thanks? for watching|subscribe|link in bio)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  const collapsed = normalized
    .split(' ')
    .filter((token, index, arr) => index === 0 || token.toLowerCase() !== arr[index - 1].toLowerCase())
    .join(' ')
    .trim();

  if (!collapsed) return '';

  const capitalized = collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
  if (/[.!?]$/.test(capitalized)) return capitalized;

  if (String(language || '').toLowerCase().startsWith('fr')) {
    return `${capitalized}.`;
  }

  return `${capitalized}.`;
};

const isCorrectionEnabled = () => {
  const value = String(process.env.VOICE_TEXT_CORRECTION_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
};

const isSummaryEnabled = () => {
  const value = String(process.env.VOICE_TEXT_SUMMARY_ENABLED || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
};

const splitSentences = (text) => String(text || '')
  .replace(/\s+/g, ' ')
  .split(/(?<=[.!?])\s+/)
  .map((item) => item.trim())
  .filter(Boolean);

const localSummarizeTranscriptionText = (text, language = 'en') => {
  const clean = normalizeWhitespace(text);
  if (!clean) return '';

  const sentences = splitSentences(clean);
  if (sentences.length <= 2) return clean;

  const selected = [sentences[0], sentences[Math.floor(sentences.length / 2)], sentences[sentences.length - 1]]
    .filter(Boolean)
    .filter((value, index, arr) => arr.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 3);

  const summary = selected.join(' ');
  if (!summary) return '';

  const normalizedLanguage = String(language || '').toLowerCase();
  if (normalizedLanguage.startsWith('fr')) {
    return `Resume: ${summary}`;
  }

  return `Summary: ${summary}`;
};

const scoreSentiment = (text) => {
  const normalized = ` ${String(text || '').toLowerCase()} `;
  let positive = 0;
  let negative = 0;

  POSITIVE_TOKENS.forEach((token) => {
    if (normalized.includes(` ${token} `)) positive += 1;
  });

  NEGATIVE_TOKENS.forEach((token) => {
    if (normalized.includes(` ${token} `)) negative += 1;
  });

  return { positive, negative, score: positive - negative };
};

const inferTranscriptionSentiment = (text) => {
  const clean = normalizeWhitespace(text);
  if (!clean) {
    return { label: 'NEUTRAL', score: 0 };
  }

  const { score } = scoreSentiment(clean);
  if (score >= 1) {
    return { label: 'POSITIVE', score };
  }
  if (score <= -1) {
    return { label: 'NEGATIVE', score };
  }
  return { label: 'NEUTRAL', score: 0 };
};

const aggregateSegmentSentiment = (segments = []) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { label: 'NEUTRAL', score: 0, counts: { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0 } };
  }

  const counts = { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0 };
  let score = 0;

  segments.forEach((segment) => {
    const sentiment = String(segment?.sentiment || inferTranscriptionSentiment(segment?.corrected_text || segment?.text || '').label).toUpperCase();
    if (counts[sentiment] === undefined) {
      counts.NEUTRAL += 1;
      return;
    }
    counts[sentiment] += 1;
    if (sentiment === 'POSITIVE') score += 1;
    if (sentiment === 'NEGATIVE') score -= 1;
  });

  const label = score > 0 ? 'POSITIVE' : score < 0 ? 'NEGATIVE' : 'NEUTRAL';
  return { label, score, counts };
};

const correctWithMistralApi = async (text, language = 'en') => {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) return null;

  const payload = {
    model: DEFAULT_CORRECTION_MODEL,
    temperature: 0.05,
    max_tokens: 220,
    messages: [
      {
        role: 'system',
        content: 'You are an ASR post-processor. Correct transcription errors and punctuation only. Do not add new facts. Keep the original language and intent. Return only corrected text.',
      },
      {
        role: 'user',
        content: `Language: ${language || 'en'}\nTranscript: ${text}`,
      },
    ],
  };

  const response = await fetch(DEFAULT_MISTRAL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const reason = await response.text().catch(() => 'unknown error');
    throw new Error(`Mistral correction failed: ${response.status} ${reason}`);
  }

  const data = await response.json();
  const candidate = String(data?.choices?.[0]?.message?.content || '').trim();
  return candidate || null;
};

const maybeCorrectTranscriptionText = async (text, language = 'en') => {
  const local = localCleanTranscriptionText(text, language);
  if (!local) return '';

  if (!isCorrectionEnabled()) return local;

  try {
    const remote = await correctWithMistralApi(local, language);
    return normalizeWhitespace(remote || local);
  } catch (error) {
    console.warn('Voice correction API fallback:', error?.message || error);
    return local;
  }
};

const summarizeWithMistralApi = async (text, language = 'en') => {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) return null;

  const payload = {
    model: DEFAULT_SUMMARY_MODEL,
    temperature: 0.1,
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: 'Summarize interview transcript in 2-3 short sentences. Keep original language. Do not invent facts. Return only plain summary text.',
      },
      {
        role: 'user',
        content: `Language: ${language || 'en'}\nTranscript: ${text}`,
      },
    ],
  };

  const response = await fetch(DEFAULT_MISTRAL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const reason = await response.text().catch(() => 'unknown error');
    throw new Error(`Mistral summary failed: ${response.status} ${reason}`);
  }

  const data = await response.json();
  const candidate = String(data?.choices?.[0]?.message?.content || '').trim();
  return candidate || null;
};

const maybeSummarizeTranscriptionText = async (text, language = 'en') => {
  const local = localSummarizeTranscriptionText(text, language);
  if (!local) return '';

  if (!isSummaryEnabled()) return local;

  try {
    const remote = await summarizeWithMistralApi(text, language);
    return normalizeWhitespace(remote || local);
  } catch (error) {
    console.warn('Voice summary API fallback:', error?.message || error);
    return local;
  }
};

const buildCorrectedSegments = (segments = [], language = 'en') => {
  if (!Array.isArray(segments)) return [];

  return segments.map((segment) => ({
    ...segment,
    corrected_text: localCleanTranscriptionText(segment?.text || '', language) || String(segment?.text || '').trim(),
    sentiment: inferTranscriptionSentiment(
      localCleanTranscriptionText(segment?.text || '', language) || String(segment?.text || '').trim(),
    ).label,
  }));
};

module.exports = {
  aggregateSegmentSentiment,
  buildCorrectedSegments,
  inferTranscriptionSentiment,
  localCleanTranscriptionText,
  localSummarizeTranscriptionText,
  maybeCorrectTranscriptionText,
  maybeSummarizeTranscriptionText,
};
