// Prompt template for POST /api/wizard/jobs/suggest-questions.
//
// Inputs: job description + required skills + interviewType (+ title and
// seniority for prompt clarity).
//
// Output schema (each suggestion drops straight into the wizard's Step 6 list,
// which uses {text, stage} per the predefinedQuestions sub-schema):
// {
//   "questions": [
//     {
//       "text":     string,
//       "stage":    "beginning" | "middle" | "end",
//       "category": "behavioral" | "technical" | "scenario" | "culture" | "closing"
//     }
//   ]
// }

const STAGE_GUIDANCE = {
  predefined:
    'Since this is a fully predefined interview (no AI-generated questions during the session), cover the full arc: warm rapport-building questions for the beginning, deep technical and scenario questions for the middle, and reflective wrap-up / candidate-questions prompts for the end.',
  hybrid:
    'Suggestions complement an adaptive AI interviewer. Mix beginning (rapport / background), middle (skills / scenarios tied to required skills), and end (closing / candidate expectations) questions. Each suggestion is anchored at the stage where it most helps the recruiter steer the conversation.',
  ai_dynamic:
    'These are optional anchor questions for an otherwise dynamic AI interview. Bias toward the middle stage (skills / scenarios) but include at least one beginning rapport question and one end closing question.',
};

function buildQuestionSuggestionPrompt({ job, count = 8, interviewType = 'hybrid' }) {
  const safeCount = Math.min(Math.max(Number(count) || 8, 3), 12);
  const stageGuidance = STAGE_GUIDANCE[interviewType] || STAGE_GUIDANCE.hybrid;

  const jobLines = [
    job?.title          ? `Job title: ${job.title}` : null,
    job?.seniorityLevel ? `Seniority: ${job.seniorityLevel}` : null,
    Array.isArray(job?.skills)    && job.skills.length    ? `Required skills: ${job.skills.join(', ')}`       : null,
    Array.isArray(job?.languages) && job.languages.length ? `Required languages: ${job.languages.join(', ')}` : null,
    job?.description    ? `Job description:\n${job.description}` : null,
  ].filter(Boolean).join('\n');

  return `You are an interview architect designing structured questions for a recruiter.
Suggest ${safeCount} interview questions for the role below, tagging each with the stage of the interview where it should be asked.

JOB CONTEXT
${jobLines || '(minimal context provided — produce questions based on the title alone)'}

STAGE GUIDANCE
${stageGuidance}

Return ONLY valid JSON matching this exact schema. Do not include markdown fences, commentary, or explanations.

{
  "questions": [
    {
      "text": "the full question, one sentence, open-ended",
      "stage": "beginning",
      "category": "behavioral"
    }
  ]
}

Constraints:
- "stage" MUST be exactly one of: "beginning", "middle", "end".
- "category" MUST be exactly one of: "behavioral", "technical", "scenario", "culture", "closing".
- Cover all three stages: at least one "beginning", several "middle", at least one "end".
- Anchor middle-stage questions to the required skills when present (e.g. "Tell me about a time you used <skill>...").
- Favor open-ended questions; avoid yes/no questions.
- Do NOT invent specific candidate names, employer names, or proprietary tools not provided.
- Each question text must be a single sentence with no inner lists.
- Output ONLY the JSON object — no preamble, no markdown.`;
}

module.exports = { buildQuestionSuggestionPrompt };
