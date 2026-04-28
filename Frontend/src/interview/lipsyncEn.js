// English text -> viseme schedule, in the spirit of TalkingHead.js's
// `lipsyncEn` and Oculus Lipsync. We map digraphs (th, sh, ch, ph, ng, ck,
// qu, ee, oo, ou, ow, etc.) and individual letters to ARKit-style visemes
// that Ready Player Me avatars expose as morph targets:
//
//   viseme_sil viseme_PP viseme_FF viseme_TH viseme_DD viseme_kk
//   viseme_CH  viseme_SS viseme_nn viseme_RR viseme_aa viseme_E
//   viseme_I   viseme_O  viseme_U
//
// This is much smaller than running an audio phoneme recognizer (Oculus
// Lipsync etc.), but the result is recognizably "moving mouth matches the
// words". For our use case (the agent's own TTS where we know the text
// exactly), this is the right tradeoff: text -> viseme is deterministic
// and noticeably better than amplitude-driven mouth flapping.

export const ALL_VISEMES = [
  'viseme_sil',
  'viseme_PP',
  'viseme_FF',
  'viseme_TH',
  'viseme_DD',
  'viseme_kk',
  'viseme_CH',
  'viseme_SS',
  'viseme_nn',
  'viseme_RR',
  'viseme_aa',
  'viseme_E',
  'viseme_I',
  'viseme_O',
  'viseme_U',
];

// Two-letter sequences win over single-letter mapping when they match.
// Order doesn't matter (longest match is picked at lookup time).
const DIGRAPHS = {
  th: 'viseme_TH',
  sh: 'viseme_CH',
  ch: 'viseme_CH',
  ph: 'viseme_FF',
  ng: 'viseme_nn',
  ck: 'viseme_kk',
  qu: 'viseme_kk',
  wh: 'viseme_U',
  gh: 'viseme_kk',
  // Vowel digraphs (approximate but noticeably better than letter-by-letter)
  ee: 'viseme_I',
  oo: 'viseme_U',
  ou: 'viseme_O',
  ow: 'viseme_O',
  au: 'viseme_aa',
  aw: 'viseme_aa',
  ai: 'viseme_aa',
  ay: 'viseme_aa',
  ea: 'viseme_E',
  ie: 'viseme_I',
  oa: 'viseme_O',
  oi: 'viseme_O',
  oy: 'viseme_O',
};

const LETTERS = {
  a: 'viseme_aa',
  e: 'viseme_E',
  i: 'viseme_I',
  o: 'viseme_O',
  u: 'viseme_U',
  // Bilabials (lips closed)
  p: 'viseme_PP',
  b: 'viseme_PP',
  m: 'viseme_PP',
  // Labiodentals (lower lip + upper teeth)
  f: 'viseme_FF',
  v: 'viseme_FF',
  // Alveolars (tongue tip)
  t: 'viseme_DD',
  d: 'viseme_DD',
  n: 'viseme_DD',
  l: 'viseme_DD',
  // Sibilants (lips spread)
  s: 'viseme_SS',
  z: 'viseme_SS',
  // Velars (back of tongue)
  c: 'viseme_kk',
  k: 'viseme_kk',
  g: 'viseme_kk',
  q: 'viseme_kk',
  x: 'viseme_kk',
  // Approximants
  r: 'viseme_RR',
  w: 'viseme_U',
  y: 'viseme_I',
  // Fricatives / breathy
  h: 'viseme_aa',
  j: 'viseme_CH',
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// "Units" are relative duration weights — vowels are held longer than
// consonants, digraphs longer than single letters, silences shortest.
function unitsFor(viseme, isVowel) {
  if (viseme === 'viseme_sil') return 0.4;
  if (isVowel) return 1.25;
  return 0.85;
}

function weightFor(viseme, isVowel) {
  if (viseme === 'viseme_sil') return 0;
  if (isVowel) return 0.85;
  // Bilabials (PP) need to fully close the mouth — don't crank too high
  // or the avatar looks like it's chewing.
  if (viseme === 'viseme_PP') return 0.65;
  return 0.6;
}

/**
 * Convert text to a sequence of timed viseme tokens.
 *
 * @param {string} text         The text being spoken.
 * @param {number} durationMs   Total audio duration to spread the visemes over.
 * @returns {Array<{ v: string, weight: number, startMs: number, endMs: number }>}
 */
export function textToVisemeSchedule(text, durationMs) {
  const clean = String(text || '').toLowerCase();
  if (!clean.trim() || !Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }

  // Pass 1: tokenize into raw visemes with relative duration units.
  const raw = [];
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];

    // Whitespace -> short silence pause.
    if (c === ' ' || c === '\t' || c === '\n') {
      raw.push({ v: 'viseme_sil', isVowel: false });
      i += 1;
      continue;
    }

    // Punctuation -> longer silence.
    if (/[.!?,;:]/.test(c)) {
      raw.push({ v: 'viseme_sil', isVowel: false });
      raw.push({ v: 'viseme_sil', isVowel: false });
      i += 1;
      continue;
    }

    // Skip anything else non-alphabetic.
    if (!/[a-z]/.test(c)) {
      i += 1;
      continue;
    }

    // Try digraph first.
    if (i + 1 < clean.length) {
      const dg = clean.slice(i, i + 2);
      if (DIGRAPHS[dg]) {
        const isVowel = VOWELS.has(dg[0]) || VOWELS.has(dg[1]);
        raw.push({ v: DIGRAPHS[dg], isVowel });
        i += 2;
        continue;
      }
    }

    if (LETTERS[c]) {
      raw.push({ v: LETTERS[c], isVowel: VOWELS.has(c) });
    }
    i += 1;
  }

  if (raw.length === 0) return [];

  // Pass 2: merge consecutive duplicates (held phonemes like "ll", "tt").
  // The merged token holds for slightly longer than a single one.
  const merged = [];
  for (const tok of raw) {
    const last = merged[merged.length - 1];
    if (last && last.v === tok.v) {
      last.units += unitsFor(tok.v, tok.isVowel) * 0.55;
    } else {
      merged.push({
        v: tok.v,
        weight: weightFor(tok.v, tok.isVowel),
        units: unitsFor(tok.v, tok.isVowel),
      });
    }
  }

  // Pass 3: distribute durationMs across tokens proportionally to units.
  const totalUnits = merged.reduce((sum, t) => sum + t.units, 0) || 1;
  let cum = 0;
  return merged.map((tok) => {
    const startMs = (cum / totalUnits) * durationMs;
    cum += tok.units;
    const endMs = (cum / totalUnits) * durationMs;
    return { v: tok.v, weight: tok.weight, startMs, endMs };
  });
}

/**
 * Find the active viseme at a given time inside the schedule.
 * Returns { v, weight, progress } or null when before/after the schedule.
 *
 * `progress` is in [0, 1] inside the active token, used for envelope shaping
 * (sin curve so each viseme ramps up then back down toward neutral).
 */
export function activeVisemeAt(schedule, elapsedMs) {
  if (!schedule || schedule.length === 0) return null;
  if (elapsedMs < 0) return null;
  // schedule is ordered, so a linear scan is fast enough; for very long
  // utterances we could binary-search but typical agent answers are <300 chars.
  for (let i = 0; i < schedule.length; i += 1) {
    const tok = schedule[i];
    if (elapsedMs >= tok.startMs && elapsedMs < tok.endMs) {
      const progress = (elapsedMs - tok.startMs) / Math.max(1, tok.endMs - tok.startMs);
      return { v: tok.v, weight: tok.weight, progress };
    }
  }
  return null;
}
