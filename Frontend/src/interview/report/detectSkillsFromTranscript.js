/**
 * Client-side technical-skill detection from interview transcripts.
 *
 * Used by SkillsEvidencePanel as a fallback when the backend pipeline did
 * not populate `report.technicalEvaluation.demonstratedSkills`. Scans the
 * candidate's answer text and the wider transcript for a curated lexicon
 * of technical keywords and classifies hits as `demonstrated` (mentioned
 * inside an answer that scored at least "acceptable") or `mentioned`
 * (everywhere else).
 *
 * Advisory only. Pure function — no side effects, no async.
 */

// ── Lexicon ────────────────────────────────────────────────────────────────
// Each entry maps a canonical display name to one or more lowercased aliases.
// Aliases are matched with word boundaries (after lowercasing the haystack
// and stripping common punctuation).
const SKILL_LEXICON = [
  // Frontend frameworks
  { name: "React", aliases: ["react", "react.js", "reactjs"] },
  { name: "Vue.js", aliases: ["vue", "vue.js", "vuejs"] },
  { name: "Angular", aliases: ["angular", "angularjs", "angular.js"] },
  { name: "Svelte", aliases: ["svelte", "sveltekit"] },
  { name: "Next.js", aliases: ["next.js", "nextjs", "next js"] },
  { name: "Nuxt.js", aliases: ["nuxt", "nuxt.js", "nuxtjs"] },
  { name: "Redux", aliases: ["redux", "redux toolkit", "rtk"] },
  { name: "Tailwind CSS", aliases: ["tailwind", "tailwindcss", "tailwind css"] },
  { name: "Bootstrap", aliases: ["bootstrap"] },
  { name: "HTML", aliases: ["html", "html5"] },
  { name: "CSS", aliases: ["css", "css3", "sass", "scss"] },
  { name: "jQuery", aliases: ["jquery"] },
  // Languages
  { name: "JavaScript", aliases: ["javascript", "js", "es6", "ecmascript"] },
  { name: "TypeScript", aliases: ["typescript", "ts"] },
  { name: "Python", aliases: ["python", "python3", "py"] },
  { name: "Java", aliases: ["java"] },
  { name: "C#", aliases: ["c#", "c-sharp", "csharp", ".net", "dotnet"] },
  { name: "C++", aliases: ["c++", "cpp"] },
  { name: "Go", aliases: ["golang", "go lang"] },
  { name: "Rust", aliases: ["rust"] },
  { name: "PHP", aliases: ["php"] },
  { name: "Ruby", aliases: ["ruby", "rails", "ruby on rails"] },
  { name: "Kotlin", aliases: ["kotlin"] },
  { name: "Swift", aliases: ["swift", "swiftui"] },
  // Backend
  { name: "Node.js", aliases: ["node", "node.js", "nodejs"] },
  { name: "Express", aliases: ["express", "express.js", "expressjs"] },
  { name: "NestJS", aliases: ["nest", "nestjs", "nest.js"] },
  { name: "Django", aliases: ["django"] },
  { name: "Flask", aliases: ["flask"] },
  { name: "FastAPI", aliases: ["fastapi", "fast api"] },
  { name: "Spring", aliases: ["spring", "spring boot", "springboot"] },
  { name: "Laravel", aliases: ["laravel"] },
  // Databases
  { name: "SQL", aliases: ["sql"] },
  { name: "PostgreSQL", aliases: ["postgres", "postgresql"] },
  { name: "MySQL", aliases: ["mysql"] },
  { name: "MongoDB", aliases: ["mongo", "mongodb"] },
  { name: "Redis", aliases: ["redis"] },
  { name: "Elasticsearch", aliases: ["elasticsearch", "elastic search"] },
  { name: "SQLite", aliases: ["sqlite"] },
  { name: "DynamoDB", aliases: ["dynamodb", "dynamo db"] },
  // Cloud & DevOps
  { name: "AWS", aliases: ["aws", "amazon web services"] },
  { name: "Azure", aliases: ["azure"] },
  { name: "GCP", aliases: ["gcp", "google cloud", "google cloud platform"] },
  { name: "Docker", aliases: ["docker", "dockerfile"] },
  { name: "Kubernetes", aliases: ["kubernetes", "k8s"] },
  { name: "Terraform", aliases: ["terraform"] },
  { name: "Jenkins", aliases: ["jenkins"] },
  { name: "GitHub Actions", aliases: ["github actions"] },
  { name: "GitLab CI", aliases: ["gitlab ci", "gitlab pipelines"] },
  { name: "CI/CD", aliases: ["ci/cd", "cicd", "continuous integration", "continuous delivery"] },
  { name: "Git", aliases: ["git", "github", "gitlab", "bitbucket"] },
  { name: "Linux", aliases: ["linux", "ubuntu", "debian", "centos"] },
  // AI / ML
  { name: "TensorFlow", aliases: ["tensorflow", "tf"] },
  { name: "PyTorch", aliases: ["pytorch", "torch"] },
  { name: "scikit-learn", aliases: ["scikit-learn", "sklearn", "scikit learn"] },
  { name: "NLP", aliases: ["nlp", "natural language processing"] },
  { name: "OpenAI / GPT", aliases: ["openai", "gpt", "chatgpt", "gpt-4", "gpt-3.5"] },
  { name: "Hugging Face", aliases: ["hugging face", "huggingface"] },
  { name: "LangChain", aliases: ["langchain", "lang chain"] },
  { name: "Pandas", aliases: ["pandas"] },
  { name: "NumPy", aliases: ["numpy"] },
  // Mobile
  { name: "React Native", aliases: ["react native", "reactnative"] },
  { name: "Flutter", aliases: ["flutter"] },
  { name: "iOS", aliases: ["ios", "swift ui"] },
  { name: "Android", aliases: ["android"] },
  // Concepts / Protocols
  { name: "REST APIs", aliases: ["rest", "rest api", "restful", "rest apis"] },
  { name: "GraphQL", aliases: ["graphql", "graph ql"] },
  { name: "WebSockets", aliases: ["websocket", "websockets", "socket.io", "socket io"] },
  { name: "gRPC", aliases: ["grpc"] },
  { name: "Microservices", aliases: ["microservice", "microservices"] },
  { name: "OAuth", aliases: ["oauth", "oauth2", "oauth 2.0"] },
  { name: "JWT", aliases: ["jwt", "json web token"] },
  { name: "OOP", aliases: ["oop", "object oriented", "object-oriented"] },
  { name: "TDD", aliases: ["tdd", "test driven", "test-driven"] },
  { name: "Agile", aliases: ["agile", "scrum", "kanban"] },
  { name: "System Design", aliases: ["system design", "distributed systems"] },
  { name: "Design Patterns", aliases: ["design pattern", "design patterns", "mvc", "mvvm"] },
  // Tools
  { name: "Webpack", aliases: ["webpack"] },
  { name: "Vite", aliases: ["vite"] },
  { name: "npm / yarn", aliases: ["npm", "yarn", "pnpm"] },
  { name: "Figma", aliases: ["figma"] },
  { name: "Jest", aliases: ["jest"] },
  { name: "Cypress", aliases: ["cypress"] },
  { name: "Playwright", aliases: ["playwright"] },
];

// ── Helpers ────────────────────────────────────────────────────────────────
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pre-compile a single global regex per alias once. Each alias matches
// case-insensitively with non-word boundaries on either side. We use
// custom boundaries instead of \b because aliases like "c++" and "c#"
// contain non-word chars that \b doesn't handle.
const SKILL_PATTERNS = SKILL_LEXICON.map((entry) => ({
  name: entry.name,
  matchers: entry.aliases.map((alias) => {
    const esc = escapeRegex(alias);
    return new RegExp(`(?:^|[^a-z0-9+#.])(${esc})(?=[^a-z0-9+#.]|$)`, "gi");
  }),
}));

const countMatches = (text, matchers) => {
  if (!text) return 0;
  let count = 0;
  for (const re of matchers) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) count += m.length;
  }
  return count;
};

const collectCandidateText = (report) => {
  if (!report) return { answerText: "", fullText: "" };

  const answerParts = [];
  const otherParts = [];

  // Q&A answers — the highest-signal source.
  const qnaItems = report?.interviewQna?.items || [];
  const qEvals = report?.questionEvaluations || [];
  qnaItems.forEach((item, idx) => {
    if (item?.answerText) {
      const ev = qEvals[idx];
      const quality = ev?.answerQuality;
      answerParts.push({
        text: String(item.answerText),
        quality, // "strong" | "acceptable" | "insufficient" | undefined
      });
    }
    if (item?.questionText) otherParts.push(String(item.questionText));
  });

  // Free-form transcript fields.
  const transcript = report.transcript || {};
  if (transcript.text) otherParts.push(String(transcript.text));
  else if (transcript.fullText) otherParts.push(String(transcript.fullText));
  (transcript.segments || []).forEach((seg) => {
    if (seg?.text) otherParts.push(String(seg.text));
  });
  if (report.transcriptSummary) otherParts.push(String(report.transcriptSummary));

  return {
    answers: answerParts, // { text, quality }[]
    fullText: [
      ...answerParts.map((p) => p.text),
      ...otherParts,
    ].join("\n"),
  };
};

// ── Public API ─────────────────────────────────────────────────────────────
export function detectSkillsFromTranscript(report, jobSkills = []) {
  const { answers, fullText } = collectCandidateText(report);
  const lowered = fullText.toLowerCase();
  if (!lowered.trim()) {
    return {
      demonstrated: [],
      mentioned: [],
      matched: [],
      missing: jobSkills.map((s) => String(s)),
      detectedFromTranscript: false,
    };
  }

  // For each skill, count total appearances and split into
  // appearances-inside-answers (with quality) vs appearances elsewhere.
  const demonstrated = []; // hit in a strong/acceptable answer
  const mentioned = []; // hit somewhere but not a strong answer

  for (const skill of SKILL_PATTERNS) {
    const totalHits = countMatches(lowered, skill.matchers);
    if (totalHits === 0) continue;

    // Check each answer separately to find the best quality this skill appeared with.
    let bestAnswerQuality = null; // "strong" > "acceptable" > "insufficient"
    let answerHits = 0;
    for (const ans of answers) {
      const hits = countMatches(ans.text.toLowerCase(), skill.matchers);
      if (hits === 0) continue;
      answerHits += hits;
      const q = ans.quality;
      const order = { strong: 3, acceptable: 2, insufficient: 1 };
      if (
        bestAnswerQuality == null ||
        (order[q] || 0) > (order[bestAnswerQuality] || 0)
      ) {
        bestAnswerQuality = q || bestAnswerQuality;
      }
    }

    if (
      answerHits > 0 &&
      (bestAnswerQuality === "strong" || bestAnswerQuality === "acceptable")
    ) {
      demonstrated.push({ name: skill.name, hits: totalHits });
    } else {
      mentioned.push({ name: skill.name, hits: totalHits });
    }
  }

  // Sort by hit count (descending) — most-discussed first
  demonstrated.sort((a, b) => b.hits - a.hits);
  mentioned.sort((a, b) => b.hits - a.hits);

  // Match against job requirements (case-insensitive, contains-match either way)
  const jobNorm = (jobSkills || [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const allFoundNames = [...demonstrated, ...mentioned].map((s) => s.name);

  const matched = [];
  const missing = [];
  for (const req of jobNorm) {
    const lowerReq = req.toLowerCase();
    const hit = allFoundNames.find((name) => {
      const n = name.toLowerCase();
      return n === lowerReq || n.includes(lowerReq) || lowerReq.includes(n);
    });
    if (hit) matched.push(hit);
    else missing.push(req);
  }

  return {
    demonstrated: demonstrated.map((s) => s.name),
    mentioned: mentioned.map((s) => s.name),
    matched,
    missing,
    detectedFromTranscript: true,
  };
}
