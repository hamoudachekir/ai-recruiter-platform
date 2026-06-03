// Prompt template for POST /api/wizard/jobs/generate-description.
//
// Receives the selected CompanyContext (industry, brand voice/description,
// website) + structured job details (title, seniority, employmentType,
// workspaceType, location, salary, skills, languages) + an optional free-text
// "user requirements" hint. Produces 2–3 distinct candidate descriptions.
//
// Output schema (consumed by the wizard's Step 4 candidate cards):
// {
//   "candidates": [
//     {
//       "summary":             string,
//       "responsibilities":    string[],
//       "requirements":        string[],
//       "benefits":            string[],
//       "growth":              string,
//       "applicationProcess":  string
//     }
//   ]
// }

function buildJobDescriptionPrompt({ context, job, userRequirements, count = 3 }) {
  const safeCount = Math.min(Math.max(Number(count) || 3, 2), 3);

  const ctxLines = [
    context?.name        ? `Company name: ${context.name}` : null,
    context?.industry    ? `Industry: ${context.industry}` : null,
    context?.description ? `Brand voice / about: ${context.description}` : null,
    context?.website     ? `Website: ${context.website}` : null,
  ].filter(Boolean).join('\n');

  const jobLines = [
    job?.title          ? `Job title: ${job.title}` : null,
    job?.seniorityLevel ? `Seniority: ${job.seniorityLevel}` : null,
    job?.employmentType ? `Employment type: ${job.employmentType}` : null,
    job?.workspaceType  ? `Workspace: ${job.workspaceType}` : null,
    job?.location       ? `Location: ${job.location}` : null,
    job?.salary         ? `Indicative salary (EUR): ${job.salary}` : null,
    Array.isArray(job?.skills)    && job.skills.length    ? `Required skills: ${job.skills.join(', ')}`       : null,
    Array.isArray(job?.languages) && job.languages.length ? `Required languages: ${job.languages.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const requirementsLine = (userRequirements || '').trim();

  return `You are an expert technical recruiter writing job descriptions on behalf of the company below.
Generate ${safeCount} distinct candidate descriptions for the role. Aim for variety in tone across candidates (for example: one concise and professional, one engaging and culture-led, one detailed and structured).

COMPANY CONTEXT
${ctxLines || '(no company context provided)'}

JOB DETAILS
${jobLines || '(no job details provided)'}

USER GUIDANCE
${requirementsLine || '(none)'}

Return ONLY valid JSON matching this exact schema. Do not include markdown fences, commentary, or explanations.

{
  "candidates": [
    {
      "summary": "1–2 paragraph overview of the role and why it matters at the company",
      "responsibilities": ["3–6 single-sentence bullets describing core duties"],
      "requirements": ["3–6 single-sentence bullets of must-have qualifications"],
      "benefits": ["2–5 single-sentence bullets of perks and benefits"],
      "growth": "1 short paragraph on career development at the company",
      "applicationProcess": "1 short paragraph describing how to apply and what to expect next"
    }
  ]
}

Constraints:
- Use the company's brand voice and industry to keep the tone consistent across the candidate's sections.
- Reflect the seniority, employment type, workspace, and required skills accurately.
- Do NOT invent specific salary numbers, dates, hiring-manager names, or proprietary tools not provided.
- Each bullet must be a single sentence with no inner lists or sub-bullets.
- Output ONLY the JSON object — no preamble, no markdown.`;
}

module.exports = { buildJobDescriptionPrompt };
