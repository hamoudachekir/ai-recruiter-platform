// Wizard step labels (always 8 in the stepper, even when Step 6 is skipped
// for ai_dynamic interviews — the skip is handled in the Continue logic).
export const STEPS = [
  { number: 1, label: 'Department' },
  { number: 2, label: 'Company Context' },
  { number: 3, label: 'Job Details' },
  { number: 4, label: 'Description' },
  { number: 5, label: 'Interview Type' },
  { number: 6, label: 'Questions' },
  { number: 7, label: 'Evaluation' },
  { number: 8, label: 'Review' },
];

export const TOTAL_STEPS = STEPS.length;

// Enum options — must stay in sync with the backend Job schema.
export const SENIORITY_LEVELS  = ['Intern', 'Junior', 'Mid', 'Senior', 'Lead'];
export const EMPLOYMENT_TYPES  = ['Full-time', 'Part-time', 'Contract', 'Internship'];
export const WORKSPACE_TYPES   = ['On-site', 'Remote', 'Hybrid'];
export const INTERVIEW_TYPES   = ['ai_dynamic', 'hybrid', 'predefined'];
export const QUESTION_STAGES   = ['beginning', 'middle', 'end'];

// Must stay in sync with voice_engine/interview_agent/irt_engine.py STYLE_DIFFICULTY_RANGES.
export const INTERVIEW_STYLES  = ['friendly', 'strict', 'senior', 'junior', 'fast_screening'];

// Multi-select option lists (per the wizard spec).
export const LANGUAGE_OPTIONS = [
  'Arabic', 'English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Turkish',
];

// Interview language is locked to the languages the voice agent / call room
// actually support. Keep this list narrow so we don't save a value the
// interview engine can't speak.
export const INTERVIEW_LANGUAGE_OPTIONS = ['French', 'English'];

export const SKILL_OPTIONS = [
  'React', 'Angular', 'Vue', 'JavaScript', 'TypeScript', 'Node.js', 'Express',
  'MongoDB', 'SQL', 'PostgreSQL', 'MySQL', 'Python', 'Java', 'C#', 'Docker',
  'Kubernetes', 'AWS', 'Azure', 'Git', 'REST API', 'GraphQL', 'Figma', 'UI/UX',
  'Machine Learning',
];

// Initial wizard data, mirrors the Job schema's writable fields.
export const INITIAL_DATA = {
  departmentId:         null,
  companyContextId:     null,
  companyName:          '',
  title:                '',
  location:             '',
  salary:               '',
  interviewLanguage:    '',
  seniorityLevel:       '',
  employmentType:       '',
  workspaceType:        '',
  languages:            [],
  skills:               [],
  recordApplicantVideo: false,
  description:          '',
  descriptionSource:    'manual',
  interviewType:        'ai_dynamic',
  predefinedQuestions:  [],
  evaluationConfig:     null,
};
