const BAD_WORDS = [
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
  'hell',
  'damn', 'damned',
  'crap', 'crappy',
  'piss', 'pissed',
  'wanker', 'wank',
  'twat',
  'bollocks',
  'tosser',
  'merde', 'putain', 'connard', 'connards', 'salope', 'salopard',
  'enculé', 'encule', 'pute', 'fdp', 'va te faire foutre',
  'fils de pute', 'ta gueule', 'bordel',
  'kess', 'sharmouta', 'ibn el sharmouta', 'yel3an', 'kol khara',
];

const compiled = BAD_WORDS.slice()
  .sort((a, b) => b.length - a.length)
  .map((word) => ({
    word,
    regex: new RegExp(
      `${/^\w/.test(word) ? '\\b' : ''}${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${/\w$/.test(word) ? '\\b' : ''}`,
      'gi',
    ),
  }));

function containsProfanity(text) {
  if (!text) return false;
  return compiled.some(({ regex }) => {
    regex.lastIndex = 0;
    return regex.test(String(text));
  });
}

module.exports = {
  containsProfanity,
};
