// ─────────────────────────────────────────────────────────────────────────────
// flattenCandidate
//
// Deterministically flattens an AI-generated candidate into the single
// `description` string the Job schema stores. The contract — promised in
// the wizard's Step 4 "Use This Description" action — is:
//
//   What the recruiter sees previewed in the candidate card is exactly
//   what gets saved to job.description.
//
// To make that contract hold, the candidate card in Step 4 renders the
// same section labels in the same order with the same bullet-style
// rendering for arrays. The card is styled but the textual content
// matches this function's output line-for-line.
//
// Output shape (sections appear only when their source field is non-empty):
//
//   Summary
//   <candidate.summary trimmed>
//
//   Key Responsibilities
//   • <responsibilities[0]>
//   • <responsibilities[1]>
//
//   Requirements
//   • <requirements[0]>
//   ...
//
//   Benefits
//   • <benefits[0]>
//   ...
//
//   Growth
//   <candidate.growth trimmed>
//
//   Application Process
//   <candidate.applicationProcess trimmed>
//
// Pure function. No side effects. Same input → identical output every time.
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_ORDER = [
  { key: 'summary',             label: 'Summary',              kind: 'paragraph' },
  { key: 'responsibilities',    label: 'Key Responsibilities', kind: 'bullets'   },
  { key: 'requirements',        label: 'Requirements',         kind: 'bullets'   },
  { key: 'benefits',            label: 'Benefits',             kind: 'bullets'   },
  { key: 'growth',              label: 'Growth',               kind: 'paragraph' },
  { key: 'applicationProcess',  label: 'Application Process',  kind: 'paragraph' },
];

const BULLET = '• ';

function renderParagraph(label, text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;
  return `${label}\n${value}`;
}

function renderBullets(label, items) {
  if (!Array.isArray(items)) return null;
  const cleaned = items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  return `${label}\n${cleaned.map((it) => `${BULLET}${it}`).join('\n')}`;
}

export function flattenCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';

  const blocks = [];
  for (const section of SECTION_ORDER) {
    const value = candidate[section.key];
    const block = section.kind === 'bullets'
      ? renderBullets(section.label, value)
      : renderParagraph(section.label, value);
    if (block) blocks.push(block);
  }

  return blocks.join('\n\n');
}
