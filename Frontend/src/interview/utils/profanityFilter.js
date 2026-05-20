/**
 * Profanity helpers for candidate interview input (typed + STT).
 *
 * Rules:
 *  - containsProfanity(text) → returns true if any bad word is present
 *  - filterProfanity(text)   → optional masking helper for display-only use
 *
 * Matching is word-boundary aware so substrings are safe
 * ("classic" does not match "ass", "assassin" does not match "ass").
 */

const BAD_WORDS = [
  // English — most common
  'fuck', 'fucker', 'fucking', 'fucked', 'fuckup', 'fucks',
  'shit', 'shits', 'shitting', 'shitty', 'bullshit',
  'bitch', 'bitches', 'bitching',
  'asshole', 'assholes', 'arse', 'arsehole',
  'bastard', 'bastards',
  'cunt', 'cunts',
  'dick', 'dicks', 'dickhead',
  'cock', 'cocks', 'cocksucker',
  'pussy', 'pussies',
  'whore', 'whores',
  'slut', 'sluts',
  'nigger', 'nigga', 'niggers',
  'faggot', 'fag', 'faggots',
  'retard', 'retarded',
  'motherfucker', 'motherfucking',
  'son of a bitch',
  'piece of shit',
  'go to hell',
  'damn', 'damned',
  'crap', 'crappy',
  'piss', 'pissed',
  'wanker', 'wank',
  'twat',
  'bollocks',
  'tosser',
  // French
  'merde', 'putain', 'connard', 'connards', 'salope', 'salopard',
  'enculé', 'encule', 'pute', 'fdp', 'va te faire foutre',
  'fils de pute', 'ta gueule', 'bordel',
  // Arabic transliterations (common ones)
  'kess', 'sharmouta', 'ibn el sharmouta', 'yel3an', 'kol khara',
];

// Pre-compile regexes once for performance.
// Sort longer phrases first so multi-word phrases match before single words.
const _compiled = BAD_WORDS.slice()
  .sort((a, b) => b.length - a.length)
  .map((word) => ({
    word,
    // Phrase matching: use \b only when word starts/ends with a word char.
    regex: new RegExp(
      `${/^\w/.test(word) ? '\\b' : ''}${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\w$/.test(word) ? '\\b' : ''}`,
      'gi',
    ),
  }));

/**
 * Replace every bad word in `text` with asterisks of the same length.
 * Returns the sanitized string.
 */
export function filterProfanity(text) {
  if (!text) return text;
  let out = text;
  for (const { regex } of _compiled) {
    out = out.replace(regex, (match) => '*'.repeat(match.length));
  }
  return out;
}

/**
 * Returns true if `text` contains at least one bad word.
 */
export function containsProfanity(text) {
  if (!text) return false;
  return _compiled.some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(text);
  });
}
