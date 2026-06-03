/**
 * migrate.js — Create all collections with sample data in ai_recruiter DB.
 *
 * Usage (from project root):
 *   node Backend/scripts/migrate.js
 *
 * Safe to re-run — checks for existing seed data before inserting.
 * Open MongoDB Compass and connect to mongodb://localhost:27017 to browse.
 */

// Resolve node_modules from Backend/server (where all packages are installed)
const path = require("path");
const serverDir = path.resolve(__dirname, "../server");
require("module").globalPaths.push(path.join(serverDir, "node_modules"));

require("dotenv").config({ path: path.resolve(serverDir, ".env") });

const mongoose = require("mongoose");
const bcrypt   = require("bcrypt");
const crypto   = require("crypto");

// ── Model imports ─────────────────────────────────────────────────────────────
const { UserModel }      = require(path.join(__dirname, "../server/models/user"));
const JobModel           = require(path.join(__dirname, "../server/models/job"));
const Department         = require(path.join(__dirname, "../server/models/department"));
const CompanyContext     = require(path.join(__dirname, "../server/models/companyContext"));
const JobInterviewRoom   = require(path.join(__dirname, "../server/models/JobInterviewRoom"));
const CallRoom           = require(path.join(__dirname, "../server/models/CallRoom"));
const Application        = require(path.join(__dirname, "../server/models/Application"));
const Message            = require(path.join(__dirname, "../server/models/Message"));
const Quiz               = require(path.join(__dirname, "../server/models/Quiz"));
const QuizResult         = require(path.join(__dirname, "../server/models/QuizResultModel"));
const CandidateQuiz      = require(path.join(__dirname, "../server/models/CandidateQuiz"));
const ComparisonReport   = require(path.join(__dirname, "../server/models/ComparisonReport"));
const { InterviewModel } = require(path.join(__dirname, "../server/models/user"));

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/ai_recruiter";

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`\n✅  Connected to ${MONGO_URI}\n`);

  // ── 1. Users ───────────────────────────────────────────────────────────────
  console.log("→ Users...");
  const hash = await bcrypt.hash("Password123!", 10);

  const adminEmail      = "admin@recruiter.io";
  const enterpriseEmail = "techcorp@recruiter.io";
  const enterprise2Email= "innova@recruiter.io";
  const c1Email         = "ahmed.bensalah@candidate.io";
  const c2Email         = "sarra.mansouri@candidate.io";
  const c3Email         = "youssef.trabelsi@candidate.io";
  const c4Email         = "nadia.chouaieb@candidate.io";

  async function upsertUser(email, data) {
    const existing = await UserModel.findOne({ email });
    if (existing) return existing;
    return UserModel.create({ email, password: hash, ...data });
  }

  const admin = await upsertUser(adminEmail, {
    name: "Platform Admin",
    role: "ADMIN",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    permissions: { canManageUsers: true, canControlPermissions: true, canOverseeSystem: true },
  });

  const enterprise = await upsertUser(enterpriseEmail, {
    name: "TechCorp HR",
    role: "ENTERPRISE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    enterprise: {
      name: "TechCorp Solutions",
      industry: "Software",
      location: "Tunis, Tunisia",
      website: "https://techcorp.example.com",
      description: "Leading software solutions provider.",
      employeeCount: 250,
    },
  });

  const enterprise2 = await upsertUser(enterprise2Email, {
    name: "InnoVa HR",
    role: "ENTERPRISE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    enterprise: {
      name: "InnoVa Labs",
      industry: "AI / Research",
      location: "Sfax, Tunisia",
      website: "https://innova.example.com",
      description: "AI research and product lab.",
      employeeCount: 60,
    },
  });

  const cand1 = await upsertUser(c1Email, {
    name: "Ahmed Ben Salah",
    role: "CANDIDATE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    profile: {
      skills: ["React", "Node.js", "MongoDB"],
      domain: "Full-Stack",
      availability: "Full-time",
      languages: ["Arabic", "French", "English"],
      shortDescription: "5 years full-stack engineer passionate about scalable systems.",
      experience: [{ title: "Senior Developer", company: "StartupX", duration: "3 years", description: "Led frontend migration to React." }],
    },
  });

  const cand2 = await upsertUser(c2Email, {
    name: "Sarra Mansouri",
    role: "CANDIDATE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    profile: {
      skills: ["Python", "Django", "PostgreSQL", "Docker"],
      domain: "Backend",
      availability: "Full-time",
      languages: ["Arabic", "French"],
      shortDescription: "Backend engineer with strong DevOps skills.",
    },
  });

  const cand3 = await upsertUser(c3Email, {
    name: "Youssef Trabelsi",
    role: "CANDIDATE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    profile: {
      skills: ["Vue.js", "TypeScript", "Figma"],
      domain: "Frontend",
      availability: "Contract",
      languages: ["Arabic", "English"],
      shortDescription: "UI/UX-focused frontend developer.",
    },
  });

  const cand4 = await upsertUser(c4Email, {
    name: "Nadia Chouaieb",
    role: "CANDIDATE",
    isActive: true,
    verificationStatus: { status: "APPROVED", emailVerified: true },
    profile: {
      skills: ["Machine Learning", "PyTorch", "FastAPI"],
      domain: "AI/ML",
      availability: "Full-time",
      languages: ["Arabic", "French", "English"],
      shortDescription: "ML engineer with a focus on NLP and computer vision.",
    },
  });

  console.log(`   users: admin, 2 enterprises, 4 candidates`);

  // ── 2. CompanyContext ──────────────────────────────────────────────────────
  console.log("→ CompanyContext...");
  let ctx = await CompanyContext.findOne({ entrepriseId: enterprise._id });
  if (!ctx) {
    ctx = await CompanyContext.create({
      name: "TechCorp Solutions",
      website: "https://techcorp.example.com",
      industry: "Software",
      description: "We build cloud-native SaaS products for enterprise clients.",
      brandColors: { primary: "#1a73e8", secondary: "#34a853", accent: "#fbbc04" },
      entrepriseId: enterprise._id,
    });
  }
  console.log(`   companycontexts: 1`);

  // ── 3. Departments ─────────────────────────────────────────────────────────
  console.log("→ Departments...");
  async function upsertDept(name, entrepriseId, description) {
    const ex = await Department.findOne({ name, entrepriseId });
    return ex || Department.create({ name, description, entrepriseId });
  }
  const deptEng  = await upsertDept("Engineering",  enterprise._id, "Software engineering teams");
  const deptData = await upsertDept("Data & AI",    enterprise._id, "Data science and AI projects");
  const deptHR   = await upsertDept("Human Resources", enterprise._id, "People operations");
  console.log(`   departments: 3`);

  // ── 4. Jobs ────────────────────────────────────────────────────────────────
  console.log("→ Jobs...");
  async function upsertJob(title, entrepriseId, extra) {
    const ex = await JobModel.findOne({ title, entrepriseId });
    return ex || JobModel.create({ title, entrepriseId, ...extra });
  }

  const job1 = await upsertJob("Senior Full-Stack Engineer", enterprise._id, {
    description: "Build and maintain high-traffic React + Node.js applications. Own features end-to-end.",
    location: "Tunis (Hybrid)",
    salary: 3500,
    languages: ["English", "French"],
    skills: ["React", "Node.js", "MongoDB", "Docker"],
    status: "OPEN",
    departmentId: deptEng._id,
    companyContextId: ctx._id,
    companyName: "TechCorp Solutions",
    seniorityLevel: "Senior",
    employmentType: "Full-time",
    workspaceType: "Hybrid",
    interviewLanguage: "English",
    interviewType: "ai_dynamic",
    evaluationConfig: {
      interviewStyle: "senior",
      minDifficulty: 3,
      maxDifficulty: 5,
      trackResilience: true,
      criteria: [
        { name: "Technical Skills",    weight: 40 },
        { name: "Problem Solving",     weight: 30 },
        { name: "Communication",       weight: 20 },
        { name: "Cultural Fit",        weight: 10 },
      ],
    },
  });

  const job2 = await upsertJob("Frontend Developer", enterprise._id, {
    description: "Craft pixel-perfect UIs using Vue.js and Tailwind CSS.",
    location: "Remote",
    salary: 2800,
    skills: ["Vue.js", "TypeScript", "Tailwind CSS"],
    status: "OPEN",
    departmentId: deptEng._id,
    companyName: "TechCorp Solutions",
    seniorityLevel: "Mid",
    employmentType: "Full-time",
    workspaceType: "Remote",
    interviewLanguage: "English",
    interviewType: "hybrid",
    predefinedQuestions: [
      { id: "q1", text: "Describe your Vue.js component architecture approach.", stage: "beginning", order: 0 },
      { id: "q2", text: "How do you handle global state in a large Vue app?",    stage: "middle",    order: 1 },
    ],
    evaluationConfig: {
      interviewStyle: "friendly",
      minDifficulty: 2,
      maxDifficulty: 4,
      criteria: [
        { name: "Frontend Skills", weight: 50 },
        { name: "Design Sense",    weight: 30 },
        { name: "Teamwork",        weight: 20 },
      ],
    },
  });

  const job3 = await upsertJob("ML Engineer", enterprise2._id, {
    description: "Research and deploy NLP models for our AI product suite.",
    location: "Sfax",
    salary: 4000,
    skills: ["PyTorch", "Python", "FastAPI", "Transformers"],
    status: "OPEN",
    companyName: "InnoVa Labs",
    seniorityLevel: "Senior",
    employmentType: "Full-time",
    workspaceType: "On-site",
    interviewLanguage: "English",
    interviewType: "ai_dynamic",
    evaluationConfig: {
      interviewStyle: "strict",
      minDifficulty: 4,
      maxDifficulty: 5,
      trackResilience: true,
      criteria: [
        { name: "ML Knowledge",   weight: 50 },
        { name: "Coding",         weight: 30 },
        { name: "Research Mindset", weight: 20 },
      ],
    },
  });
  console.log(`   jobs: 3`);

  // ── 5. JobInterviewRooms ───────────────────────────────────────────────────
  console.log("→ JobInterviewRooms...");
  async function upsertRoom(jobId, company, createdBy, title) {
    const ex = await JobInterviewRoom.findOne({ job: jobId, company });
    if (ex) return ex;
    return JobInterviewRoom.create({
      job: jobId,
      company,
      createdBy,
      slug: JobInterviewRoom.generateSlug(),
      title,
      status: "open",
      settings: { interviewStyle: "friendly", maxCandidates: 0, requireFaceVerification: false },
    });
  }

  const room1 = await upsertRoom(job1._id, enterprise._id, enterprise._id, "Senior Full-Stack — May 2026 Batch");
  const room2 = await upsertRoom(job2._id, enterprise._id, enterprise._id, "Frontend Developer — June 2026");
  console.log(`   jobinterviewrooms: 2`);

  // ── 6. CallRooms ──────────────────────────────────────────────────────────
  console.log("→ CallRooms...");
  const candidateList = [
    { user: cand1, tech: 89, hr: 77, sentiment: 0.36 },
    { user: cand2, tech: 82, hr: 88, sentiment: 0.82 },
    { user: cand3, tech: 71, hr: 80, sentiment: 0.76 },
    { user: cand4, tech: 67, hr: 90, sentiment: 0.90 },
  ];

  for (let i = 0; i < candidateList.length; i++) {
    const { user, tech, hr, sentiment } = candidateList[i];
    const existing = await CallRoom.findOne({ jobInterviewRoom: room1._id, candidate: user._id });
    if (existing) continue;
    await CallRoom.create({
      roomId: `seed-room1-${crypto.randomBytes(6).toString("hex")}`,
      initiator: enterprise._id,
      initiatorRole: "enterprise",
      candidate: user._id,
      job: job1._id,
      company: enterprise._id,
      jobInterviewRoom: room1._id,
      status: "ended",
      recordingStartedAt: new Date(Date.now() - 7200000),
      recordingEndedAt:   new Date(Date.now() - 3600000),
      transcription: {
        text: `Interview transcript for ${user.name}. Candidate answered all technical questions clearly.`,
        overallSentiment: { label: sentiment > 0.6 ? "POSITIVE" : "NEUTRAL", score: sentiment },
      },
      messages: [
        { role: "agent",     text: "Hello! Let's start. Tell me about yourself.", timestamp: new Date(Date.now() - 7100000) },
        { role: "candidate", text: `Hi, I'm ${user.name}. I have ${3 + i} years of experience.`,   timestamp: new Date(Date.now() - 7000000) },
        { role: "agent",     text: "Great. Walk me through a challenging project.",  timestamp: new Date(Date.now() - 6900000) },
        { role: "candidate", text: "Sure. I led the migration of a monolith to microservices.", timestamp: new Date(Date.now() - 6800000) },
      ],
      recruiterReport: {
        scoreBreakdown: {
          technicalScore: tech,
          hrScore: hr,
          integrityScore: 88 + i,
          answerCompleteness: 85 + i,
          totalScore: Math.round(tech * 0.4 + hr * 0.3 + (85 + i) * 0.3),
        },
        technicalEvaluation: { theta: 0.6 + i * 0.08, score: tech, resilienceIndex: 70 + i * 5, answerCompleteness: 85 + i },
        hrEvaluation: { score: hr },
        integrityScore: 88 + i,
        finalRecommendation: { overallScore: tech },
      },
      rhDecision: { status: "pending", notes: "", decidedAt: "" },
      visionMonitoring: {
        summary: { totalChecks: 120, faceDetectedChecks: 115, noFaceChecks: 5, multipleFacesChecks: 0, lightingIssueChecks: 2, positionIssueChecks: 3, distanceIssueChecks: 1 },
      },
    });
  }

  // One active session for room2
  const activeExists = await CallRoom.findOne({ jobInterviewRoom: room2._id });
  if (!activeExists) {
    await CallRoom.create({
      roomId: `seed-room2-${crypto.randomBytes(6).toString("hex")}`,
      initiator: enterprise._id,
      initiatorRole: "enterprise",
      candidate: cand3._id,
      job: job2._id,
      company: enterprise._id,
      jobInterviewRoom: room2._id,
      status: "waiting_confirmation",
      candidateJoinRequestedAt: new Date(),
    });
  }
  console.log(`   callrooms: 5`);

  // ── 7. Applications ────────────────────────────────────────────────────────
  console.log("→ Applications...");
  async function upsertApp(jobId, candidateUser, enterpriseId, decision) {
    const ex = await Application.findOne({ jobId, candidateId: candidateUser._id });
    if (ex) return ex;
    return Application.create({
      jobId,
      candidateId: candidateUser._id,
      enterpriseId,
      fullName: candidateUser.name,
      email:    candidateUser.email,
      phone:    "+216 50 000 00" + String(Math.floor(Math.random() * 99)).padStart(2, "0"),
      recruiterDecision: decision,
      appliedAt: new Date(Date.now() - Math.random() * 30 * 86400000),
    });
  }

  await upsertApp(job1._id, cand1, enterprise._id, "INTERVIEW");
  await upsertApp(job1._id, cand2, enterprise._id, "INTERVIEW");
  await upsertApp(job1._id, cand3, enterprise._id, "PENDING");
  await upsertApp(job2._id, cand3, enterprise._id, "INTERVIEW");
  await upsertApp(job3._id, cand4, enterprise2._id, "PENDING");
  console.log(`   applications: 5`);

  // ── 8. Messages ────────────────────────────────────────────────────────────
  console.log("→ Messages...");
  const msgExists = await Message.findOne({ from: enterprise._id });
  if (!msgExists) {
    const base = Date.now() - 86400000;
    await Message.insertMany([
      { from: enterprise._id, to: cand1._id, text: "Hi Ahmed, we'd like to invite you to an interview.", timestamp: new Date(base) },
      { from: cand1._id,      to: enterprise._id, text: "Thank you! I'm available this week.",            timestamp: new Date(base + 3600000) },
      { from: enterprise._id, to: cand2._id, text: "Hi Sarra, your application looks great.",            timestamp: new Date(base + 7200000) },
      { from: cand2._id,      to: enterprise._id, text: "Excited to hear from you!",                     timestamp: new Date(base + 10800000) },
      { from: enterprise._id, to: cand4._id, text: "Nadia, we're reviewing your profile for the ML role.", timestamp: new Date(base + 14400000) },
    ]);
  }
  console.log(`   messages: 5`);

  // ── 9. Interviews ──────────────────────────────────────────────────────────
  console.log("→ Interviews...");
  const itvExists = await InterviewModel.findOne({ enterpriseId: enterprise._id });
  if (!itvExists) {
    await InterviewModel.insertMany([
      {
        jobId: job1._id, enterpriseId: enterprise._id, candidateId: cand1._id,
        date: new Date(Date.now() + 2 * 86400000),
        status: "Scheduled",
        meeting: { type: "Virtual", link: "https://meet.example.com/abc123", details: "Join 5 min early." },
      },
      {
        jobId: job1._id, enterpriseId: enterprise._id, candidateId: cand2._id,
        date: new Date(Date.now() - 86400000),
        status: "Completed",
        meeting: { type: "Virtual", link: "https://meet.example.com/xyz789" },
        evaluation: { technical: 82, communication: 88, culturalFit: 80, overall: 84 },
        feedback: { rating: 4, comments: "Strong backend skills. Good communication." },
        callDuration: 2700,
        callStatus: "completed",
      },
    ]);
  }
  console.log(`   interviews: 2`);

  // ── 10. Quiz ───────────────────────────────────────────────────────────────
  console.log("→ Quizzes...");
  let quiz1 = await Quiz.findOne({ jobId: job1._id });
  if (!quiz1) {
    quiz1 = await Quiz.create({
      jobId: job1._id,
      questions: [
        {
          title: "Async JS",
          question: "What does `async/await` do in JavaScript?",
          type: "QCM",
          domain: "JavaScript",
          skills: ["async", "promises"],
          difficulty: "moyen",
          options: ["Makes code synchronous", "Handles promises elegantly", "Runs code in a worker", "Disables callbacks"],
          correctAnswer: 1,
          explanation: "async/await is syntactic sugar over Promises.",
          score: 2,
          timeLimit: 60,
        },
        {
          title: "React Hooks",
          question: "Which hook replaces componentDidMount in React functional components?",
          type: "QCM",
          domain: "React",
          skills: ["hooks", "lifecycle"],
          difficulty: "facile",
          options: ["useState", "useRef", "useEffect", "useCallback"],
          correctAnswer: 2,
          explanation: "useEffect with empty deps runs once after mount.",
          score: 2,
          timeLimit: 45,
        },
        {
          title: "MongoDB Index",
          question: "What type of index improves text search in MongoDB?",
          type: "réponse courte",
          domain: "Database",
          skills: ["mongodb", "indexing"],
          difficulty: "difficile",
          expectedAnswer: "text index",
          explanation: "MongoDB's text index tokenizes strings for full-text search.",
          score: 3,
          timeLimit: 90,
        },
      ],
    });
  }
  console.log(`   quizzes: 1`);

  // ── 11. CandidateQuiz ─────────────────────────────────────────────────────
  console.log("→ CandidateQuiz...");
  const cqExists = await CandidateQuiz.findOne({ candidateId: cand1._id, jobId: job1._id });
  if (!cqExists) {
    await CandidateQuiz.create({
      candidateId: cand1._id,
      jobId: job1._id,
      generatedBy: enterprise._id,
      source: "mistral-api",
      generationMeta: { jobTitle: "Senior Full-Stack Engineer", skillsUsed: ["React", "Node.js", "MongoDB"] },
      questions: quiz1.questions,
    });
    await CandidateQuiz.create({
      candidateId: cand2._id,
      jobId: job1._id,
      generatedBy: enterprise._id,
      source: "mistral-api",
      generationMeta: { jobTitle: "Senior Full-Stack Engineer", skillsUsed: ["Python", "Docker"] },
      questions: quiz1.questions,
    });
  }
  console.log(`   candidatequizzes: 2`);

  // ── 12. QuizResult ────────────────────────────────────────────────────────
  console.log("→ QuizResults...");
  const qrExists = await QuizResult.findOne({ candidateId: cand1._id });
  if (!qrExists) {
    await QuizResult.create({
      candidateId: cand1._id,
      jobId: job1._id,
      score: 7,
      totalQuestions: 3,
      timeSpentSeconds: 185,
      answers: [
        { questionIndex: 0, selectedAnswerIndex: 1, selectedAnswerText: "Handles promises elegantly", isCorrect: true,  evaluationMode: "auto-options" },
        { questionIndex: 1, selectedAnswerIndex: 2, selectedAnswerText: "useEffect",                  isCorrect: true,  evaluationMode: "auto-options" },
        { questionIndex: 2, selectedAnswerIndex: null, selectedAnswerText: "text index",              isCorrect: true,  needsHumanReview: false, evaluationMode: "short-answer" },
      ],
      submittedAt: new Date(Date.now() - 2 * 86400000),
      submissionValidation: { totalTimeValid: true, averageTimePerQuestion: 61.7, flagged: false },
    });
  }
  console.log(`   quizresults: 1`);

  // ── 13. ComparisonReport ──────────────────────────────────────────────────
  console.log("→ ComparisonReport...");
  const crExists = await ComparisonReport.findOne({ jobInterviewRoom: room1._id });
  if (!crExists) {
    const sessions = await CallRoom.find({ jobInterviewRoom: room1._id, status: "ended" }).lean();
    if (sessions.length >= 2) {
      const candidateNames = { [cand1._id]: cand1.name, [cand2._id]: cand2.name, [cand3._id]: cand3.name, [cand4._id]: cand4.name };
      const candidateEmails = { [cand1._id]: cand1.email, [cand2._id]: cand2.email, [cand3._id]: cand3.email, [cand4._id]: cand4.email };
      await ComparisonReport.create({
        jobInterviewRoom: room1._id,
        job: job1._id,
        company: enterprise._id,
        requestedBy: enterprise._id,
        generatedAt: new Date(),
        status: "ready",
        sessionIds: sessions.map((s) => s._id),
        candidateCount: sessions.length,
        rankings: sessions.map((s, idx) => ({
          candidate: s.candidate,
          session: s._id,
          candidateName:  candidateNames[s.candidate]  || "Unknown",
          candidateEmail: candidateEmails[s.candidate] || "",
          rank: idx + 1,
          suitabilityScore: 90 - idx * 5,
          compositeScore:   88 - idx * 4,
          compositeBreakdown: {
            technical:   s.recruiterReport?.scoreBreakdown?.technicalScore || 80,
            hr_fit:      s.recruiterReport?.scoreBreakdown?.hrScore        || 75,
            resilience:  70 + idx * 3,
            communication: 78 + idx * 2,
          },
          metrics: {
            technicalScore:    s.recruiterReport?.scoreBreakdown?.technicalScore || 80,
            hrScore:           s.recruiterReport?.scoreBreakdown?.hrScore        || 75,
            integrityScore:    s.recruiterReport?.scoreBreakdown?.integrityScore || 85,
            answerCompleteness: s.recruiterReport?.scoreBreakdown?.answerCompleteness || 80,
          },
          strengths: idx === 0 ? ["System design", "React expertise"] : ["Communication", "Team player"],
          gaps:       idx === 0 ? ["DevOps exposure"] : ["Advanced algorithms"],
          strongestPoint:      idx === 0 ? "Strong full-stack ownership" : "Excellent soft skills",
          mainWeakness:        idx === 0 ? "Limited cloud experience" : "Weaker algorithmic depth",
          hiringRecommendation: idx === 0 ? "Strongly Recommend" : idx === 1 ? "Recommend" : "Consider",
          justification: `Candidate ranked ${idx + 1} based on composite score of ${88 - idx * 4}.`,
        })),
        executiveSummary: "TechCorp Senior Full-Stack cohort shows strong technical competency. Top candidate excels in system design and full-stack ownership.",
        narrativeComparison: "Ahmed leads in technical depth while Sarra demonstrates superior communication and HR fit.",
        recommendedCandidateId: String(sessions[0]._id),
        confidencePct: 87,
        llmProvider: "gemini-2.5-flash-lite",
      });
    }
  }
  console.log(`   comparisonreports: 1`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n✅  Migration complete!\n");
  console.log("Collections created in database: ai_recruiter");
  console.log("  • users             (7 docs: 1 admin, 2 enterprise, 4 candidates)");
  console.log("  • jobs              (3 docs)");
  console.log("  • departments       (3 docs)");
  console.log("  • companycontexts   (1 doc)");
  console.log("  • jobinterviewrooms (2 docs)");
  console.log("  • callrooms         (5 docs)");
  console.log("  • applications      (5 docs)");
  console.log("  • messages          (5 docs)");
  console.log("  • interviews        (2 docs)");
  console.log("  • quizzes           (1 doc)");
  console.log("  • candidatequizzes  (2 docs)");  // CandidateQuiz → candidatequizzes
  console.log("  • quizresults       (1 doc)");
  console.log("  • comparisonreports (1 doc)");
  console.log("\nOpen MongoDB Compass → mongodb://localhost:27017 → ai_recruiter");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err.message);
  console.error(err);
  process.exit(1);
});
