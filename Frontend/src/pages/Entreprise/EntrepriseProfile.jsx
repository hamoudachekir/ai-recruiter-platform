import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "react-toastify";
import PublicLayout from "../../layouts/PublicLayout";
import "./EntrepriseProfile.css";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { 
  faTrashCan, faBuilding, faIndustry, 
  faLocationDot, faGlobe, faFileLines, 
  faPeopleGroup, faEdit, faSave, faTimes, 
  faBriefcase, faCamera, faPlus, faMinus, 
  faPlusCircle, faCalendarAlt, faVideo, faBoxArchive, faRotateLeft,
  faEnvelope, faLock, faKey
} from "@fortawesome/free-solid-svg-icons";

const EntrepriseProfile = () => {
  const { id } = useParams();
  const [enterprise, setEnterprise] = useState(null);
  const [userEmail, setUserEmail] = useState("");
  const [enterpriseJobs, setEnterpriseJobs] = useState([]);
  const [userPicture, setUserPicture] = useState(null);
  const [loading, setLoading] = useState(true);
  const [imagePreview, setImagePreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedEnterprise, setEditedEnterprise] = useState({});
  const [showJobForm, setShowJobForm] = useState(false);
  const [editingJobCardId, setEditingJobCardId] = useState(null);
  const [editingJobCardData, setEditingJobCardData] = useState({
    title: "",
    description: "",
    location: "",
    salary: "",
    languages: "",
    skills: "",
  });
  const [applications, setApplications] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [applicationCounts, setApplicationCounts] = useState({});
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedApplications, setSelectedApplications] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showInterviewModal, setShowInterviewModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [passwordData, setPasswordData] = useState({
    newPassword: "",
    confirmPassword: ""
  });
  const [interviewDetails, setInterviewDetails] = useState({
    type: 'Virtual',
    link: '',
    date: '',
    time: '',
    notes: ''
  });
  const [scheduledInterviews, setScheduledInterviews] = useState([]);
  const [showQuizFormModal, setShowQuizFormModal] = useState(false);
  const [quizJobId, setQuizJobId] = useState(null);
  const [quizQuestions, setQuizQuestions] = useState([
    { question: "", options: ["", "", "", ""], correctAnswer: 0 },
  ]);
  const [quizBlueprint, setQuizBlueprint] = useState({ totalQuestions: 10 });
  const [isGeneratingQuiz, setIsGeneratingQuiz] = useState(false);
  const [generationInfo, setGenerationInfo] = useState(null);
  const [jobCandidatesForQuiz, setJobCandidatesForQuiz] = useState([]);
  const [selectedQuizCandidateId, setSelectedQuizCandidateId] = useState("");
  const [jobQuizLengths, setJobQuizLengths] = useState({});

  const [newJob, setNewJob] = useState({
    title: "",
    description: "",
    location: "",
    salary: "",
    languages: "",
    skills: "",
  });
  const [languageInput, setLanguageInput] = useState("");
  const [skillInput, setSkillInput] = useState("");
  const [selectedLanguages, setSelectedLanguages] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);

  const languageSuggestions = [
    "Arabic", "English", "French", "German", "Spanish", "Italian", "Portuguese", "Turkish"
  ];

  const skillSuggestions = [
    "React", "Angular", "Vue", "JavaScript", "TypeScript", "Node.js", "Express", "MongoDB",
    "SQL", "PostgreSQL", "MySQL", "Python", "Java", "C#", "Docker", "Kubernetes", "AWS",
    "Azure", "Git", "REST API", "GraphQL", "Figma", "UI/UX", "Machine Learning"
  ];

  const fileInputRef = useRef(null);
  const totalApplications = Object.values(applicationCounts).reduce(
    (sum, count) => sum + (Number(count) || 0),
    0
  );
  const activeJobs = enterpriseJobs.filter((job) => job.status !== "CLOSED");
  const archivedJobs = enterpriseJobs.filter((job) => job.status === "CLOSED");
  const activeJobsCount = activeJobs.length;
  const archivedJobsCount = archivedJobs.length;

  const formatQuizDuration = (seconds) => {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const normalizeMongoId = (value) => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      return String(value._id || value.id || "");
    }
    return String(value);
  };

  const computeQuizQuality = (validation = {}, totalQuestions = 0) => {
    const semanticDuplicatesRemoved = Number(validation?.semanticDuplicatesRemoved || 0);
    const difficultyFixCount = Number(validation?.difficultyFixCount || 0);
    const weakAfter = Number(validation?.weakQuestionCountAfter || 0);
    const timeTarget = Number(validation?.timeBudget?.target || 0);
    const timeActual = Number(validation?.timeBudget?.actualAfter || 0);
    const timeDelta = Math.abs(timeTarget - timeActual);

    let score = 100;
    score -= semanticDuplicatesRemoved * 3;
    score -= difficultyFixCount * 4;
    score -= weakAfter * 6;
    score -= timeDelta > 0 ? Math.min(20, Math.round((timeDelta / Math.max(1, timeTarget)) * 100)) : 0;

    const normalizedScore = Math.max(0, Math.min(100, score));
    if (normalizedScore >= 85) {
      return { label: "Excellent", className: "quiz-quality-excellent", score: normalizedScore };
    }
    if (normalizedScore >= 65) {
      return { label: "Correct", className: "quiz-quality-good", score: normalizedScore };
    }
    return { label: "À revoir", className: "quiz-quality-needs-review", score: normalizedScore };
  };

  const generateQuizFromBlueprint = async () => {
    if (!quizJobId) {
      alert("Please select a job first.");
      return;
    }

    if (!selectedQuizCandidateId) {
      alert("Please select a candidate first.");
      return;
    }

    try {
      setIsGeneratingQuiz(true);
      setGenerationInfo(null);

      const targetCount = Math.max(1, Math.min(20, Number(quizBlueprint.totalQuestions) || 10));
      const response = await axios.post("http://localhost:3001/Frontend/generate-quiz-from-profile", {
        jobId: quizJobId,
        candidateId: selectedQuizCandidateId,
        totalQuestions: targetCount,
        forceMistral: true,
        generatedBy: localStorage.getItem("userId") || null,
      });

      const meta = response?.data?.meta || {};
      const source = meta.source;

      if (source !== "mistral-api") {
        throw new Error(
          meta.fallbackReason ||
          "Mistral was not used. Check API key, model name, and service logs."
        );
      }

      const generatedQuestions = response?.data?.questions || [];
      if (!generatedQuestions.length) {
        alert("No quiz generated. Verify candidate profiles and AI service.");
        return;
      }

      setQuizQuestions(generatedQuestions);
      const postValidation = meta?.postValidation || meta?.generationTrace?.validation || {};
      const quality = computeQuizQuality(postValidation, generatedQuestions.length);
      setGenerationInfo({
        source,
        model: meta.model,
        count: generatedQuestions.length,
        postValidation,
        quality,
      });
      setJobCandidatesForQuiz((prev) =>
        prev.map((candidate) =>
          candidate.candidateId === selectedQuizCandidateId
            ? { ...candidate, hasQuiz: true, quizQuestionCount: generatedQuestions.length, quizSource: source }
            : candidate
        )
      );
      alert(`✅ ${generatedQuestions.length} questions generated with Mistral model: ${meta.model || "default"}.`);
    } catch (error) {
      console.error("Error generating quiz from AI service:", error);
      const backendMessage = error.response?.data?.meta?.fallbackReason || error.response?.data?.message || error.message || "Failed to generate quiz.";
      alert(`${backendMessage}\nMake sure Mistral is reachable and quiz_generation_service.py is running on port 5003.`);
    } finally {
      setIsGeneratingQuiz(false);
    }
  };

  // Fetch scheduled interviews for the job
  const fetchInterviews = async (jobId) => {
    try {
      const res = await axios.get(`http://localhost:3001/api/interviews/job/${jobId}?enterpriseId=${id}`);
      setScheduledInterviews(res.data);
    } catch (err) {
      console.error("Error fetching interviews:", err);
    }
  };

  const fetchQuizLengths = async () => {
    try {
      const res = await axios.get('http://localhost:3001/Frontend/quiz-lengths');
      setJobQuizLengths(res.data);
    } catch (err) {
      console.error("Error fetching quiz lengths:", err);
    }
  };

  const openQuizFormModal = async (jobId) => {
    try {
      const candidatesRes = await axios.get(`http://localhost:3001/Frontend/job-candidate-quizzes/${jobId}`);
      const candidates = candidatesRes?.data?.candidates || [];

      setJobCandidatesForQuiz(candidates);
      setQuizJobId(jobId);
      setGenerationInfo(null);

      if (candidates.length > 0) {
        const firstCandidateId = String(candidates[0].candidateId);
        setSelectedQuizCandidateId(firstCandidateId);

        try {
          const candidateQuizRes = await axios.get(`http://localhost:3001/Frontend/candidate-quiz/${jobId}/${firstCandidateId}`);
          if (candidateQuizRes.data?.questions?.length) {
            setQuizQuestions(candidateQuizRes.data.questions);
          } else {
            setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
          }
        } catch {
          setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
        }
      } else {
        setSelectedQuizCandidateId("");
        setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
      }

      setShowQuizFormModal(true);
    } catch (err) {
      console.error("Error fetching candidate quizzes:", err);
      setJobCandidatesForQuiz([]);
      setSelectedQuizCandidateId("");
      setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
      setQuizJobId(jobId);
      setShowQuizFormModal(true);
    }
  };

  const handleSelectQuizCandidate = async (candidateId) => {
    const normalizedId = String(candidateId || "");
    setSelectedQuizCandidateId(normalizedId);
    setGenerationInfo(null);

    if (!normalizedId || !quizJobId) {
      setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
      return;
    }

    try {
      const res = await axios.get(`http://localhost:3001/Frontend/candidate-quiz/${quizJobId}/${normalizedId}`);
      if (res.data?.questions?.length) {
        setQuizQuestions(res.data.questions);
      } else {
        setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
      }
    } catch {
      setQuizQuestions([{ question: "", options: ["", "", "", ""], correctAnswer: 0 }]);
    }
  };

  useEffect(() => {
    const fetchJobs = async () => {
      try {
        const userId = localStorage.getItem("userId");
        const [jobsRes, countRes] = await Promise.all([
          axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${userId}`),
          axios.get(`http://localhost:3001/Frontend/job-applications-count/${userId}`),
        ]);
        setJobs(jobsRes.data);
        setApplicationCounts(countRes.data);
        fetchQuizLengths();
      } catch (error) {
        console.error("❌ Failed to fetch jobs or counts", error);
      }
    };

    fetchJobs();
  }, []);

  useEffect(() => {
    const fetchApplications = async () => {
      try {
        const enterpriseId = localStorage.getItem("userId");
        const res = await axios.get(`http://localhost:3001/Frontend/applications/${enterpriseId}`);
        setApplications(res.data);
      } catch (err) {
        console.error("❌ Error fetching applications:", err);
      }
    };

    fetchApplications();
  }, []);

  useEffect(() => {
    const fetchEntreprise = async () => {
      try {
        const res = await axios.get(`http://localhost:3001/Frontend/user/${id}`);
        setEnterprise(res.data.User.enterprise);
        setUserEmail(res.data.User.email || "");
        setUserPicture(res.data.User.picture);
        setEditedEnterprise(res.data.User.enterprise);
        setLoading(false);
      } catch (err) {
        console.error("Error fetching enterprise:", err);
      }
    };

    const fetchEnterpriseJobs = async () => {
      try {
        const res = await axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${id}`);
        setEnterpriseJobs(res.data);
      } catch (err) {
        console.error("Error fetching enterprise jobs:", err);
      }
    };

    fetchEntreprise();
    fetchEnterpriseJobs();
  }, [id]);

  // Call fetchInterviews when job is selected
  useEffect(() => {
    if (selectedJobId) {
      fetchInterviews(selectedJobId);
    }
  }, [selectedJobId]);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const imageUrl = URL.createObjectURL(file);
      setImagePreview(imageUrl);
      setSelectedFile(file);
    }
  };

  const handleDeleteJob = async (jobId) => {
    const confirm = window.confirm("Are you sure you want to delete this job?");
    if (!confirm) return;

    try {
      await axios.delete(`http://localhost:3001/Frontend/delete-job/${jobId}`);
      setEnterpriseJobs((prev) => prev.filter((job) => job._id !== jobId));
    } catch (error) {
      console.error("Error deleting job:", error);
    }
  };

  const handleEditJob = (job) => {
    setEditingJobCardId(job._id);
    setEditingJobCardData({
      title: job.title || "",
      description: job.description || "",
      location: job.location || "",
      salary: job.salary || "",
      languages: Array.isArray(job.languages) ? job.languages.join(", ") : "",
      skills: Array.isArray(job.skills) ? job.skills.join(", ") : "",
    });
  };

  const handleEditJobCardChange = (e) => {
    const { name, value } = e.target;
    setEditingJobCardData((prev) => ({ ...prev, [name]: value }));
  };

  const handleCancelEditJobCard = () => {
    setEditingJobCardId(null);
    setEditingJobCardData({
      title: "",
      description: "",
      location: "",
      salary: "",
      languages: "",
      skills: "",
    });
  };

  const handleSaveEditJobCard = async (jobId) => {
    try {
      await axios.put(`http://localhost:3001/Frontend/update-job/${jobId}`, {
        entrepriseId: id,
        title: editingJobCardData.title,
        description: editingJobCardData.description,
        location: editingJobCardData.location,
        salary: editingJobCardData.salary,
        languages: editingJobCardData.languages.split(",").map((lang) => lang.trim()).filter(Boolean),
        skills: editingJobCardData.skills.split(",").map((skill) => skill.trim()).filter(Boolean),
      });

      const res = await axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${id}`);
      setEnterpriseJobs(res.data);
      handleCancelEditJobCard();
      toast.success("Job updated successfully!");
    } catch (error) {
      console.error("Error updating job:", error);
      toast.error(error?.response?.data?.message || "Failed to update job.");
    }
  };

  const handleArchiveJob = async (jobId) => {
    const confirmArchive = window.confirm("Archive this job? It will no longer be active for new applications.");
    if (!confirmArchive) return;

    try {
      await axios.put(`http://localhost:3001/Frontend/archive-job/${jobId}`, {
        entrepriseId: id,
      });

      const res = await axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${id}`);
      setEnterpriseJobs(res.data);
      toast.success("Job archived successfully!");
    } catch (error) {
      console.error("Error archiving job:", error);
      toast.error(error?.response?.data?.message || "Failed to archive job.");
    }
  };

  const handleUnarchiveJob = async (jobId) => {
    try {
      await axios.put(`http://localhost:3001/Frontend/unarchive-job/${jobId}`, {
        entrepriseId: id,
      });

      const res = await axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${id}`);
      setEnterpriseJobs(res.data);
      toast.success("Job unarchived successfully!");
    } catch (error) {
      console.error("Error unarchiving job:", error);
      toast.error(error?.response?.data?.message || "Failed to unarchive job.");
    }
  };

const openApplicationModal = async (jobId) => {
  try {
    const res = await axios.get(`http://localhost:3001/Frontend/job-applications/${jobId}`);
    
    // Handle different response formats
    let applications = [];
    
    if (Array.isArray(res.data)) {
      applications = res.data;
    } else if (res.data && Array.isArray(res.data.applications)) {
      applications = res.data.applications;
    } else if (res.data && typeof res.data === 'object') {
      applications = [res.data];
    }
    
    const candidatesWithQuiz = applications.filter((app) => Number(app.quizLength || 0) > 0);

    const enrichedCandidates = candidatesWithQuiz.map((app) => {
      const quizLength = Number(app.quizLength || 0);
      const passingScore = quizLength ? Math.ceil(quizLength / 2) : 0;
      const quizScore = Number(app.quizScore || 0);
      return {
        ...app,
        quizLength,
        passingScore,
        quizPercent: quizLength ? Math.round((quizScore / quizLength) * 100) : 0,
        isQualified: quizLength ? quizScore >= passingScore : false,
      };
    });
  
    // Get job details for ML prediction
    const jobRes = await axios.get(`http://localhost:3001/Frontend/job/${jobId}`);
    const job = jobRes.data;

    // Enhance candidates with ML predictions
    const qualifiedCandidates = await Promise.all(
      enrichedCandidates
        .map(async (app) => {
          try {
            // Get ML prediction for each candidate
            const predictionRes = await axios.post('http://localhost:3001/predict-from-skills', {
              candidate_skills: app.candidateId.profile?.skills || [],
              job_skills: job.skills || [],
              candidate_exp: app.candidateId.profile?.experience || 0,
              required_exp: job.requiredExperience || 1,
              candidate_education: app.candidateId.profile?.education || '',
              required_education: job.education || ''
            });

            return {
              ...app,
              mlPrediction: {
                hired: predictionRes.data.hired === 1,
                confidence: Math.round(predictionRes.data.confidence * 100),
                matches: predictionRes.data.matches
              }
            };
          } catch (error) {
            console.error(`Error getting prediction for candidate ${app.candidateId._id}:`, error);
            return {
              ...app,
              mlPrediction: null
            };
          }
        })
    );

    // Sort candidates by ML prediction confidence (highest first)
    qualifiedCandidates.sort((a, b) => {
      if (a.mlPrediction && b.mlPrediction) {
        return b.mlPrediction.confidence - a.mlPrediction.confidence;
      }
      if (a.isQualified !== b.isQualified) {
        return a.isQualified ? -1 : 1;
      }
      return 0;
    });

    setSelectedApplications(qualifiedCandidates);
    setSelectedJobId(jobId);
    setShowModal(true);
  } catch (err) {
    console.error("❌ Failed to fetch applications for job:", jobId, err);
    setSelectedApplications([]);
    setShowModal(true);
  }
};
  const handleScheduleInterview = (candidate) => {
    setSelectedCandidate(candidate);
    setShowInterviewModal(true);
  };

  const handleInterviewChange = (e) => {
    const { name, value } = e.target;
    setInterviewDetails(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmitInterview = async () => {
  try {
    // First get prediction
    const predictionRes = await axios.post('http://localhost:3001/Frontend/predict-score', {
      jobId: selectedJobId,
      candidateId: selectedCandidate.candidateId._id
    });

    const interviewData = {
      jobId: selectedJobId,
      enterpriseId: id,
      candidateId: selectedCandidate.candidateId._id,
      date: new Date(`${interviewDetails.date}T${interviewDetails.time}`),
      status: 'Scheduled',
      meeting: {
        type: interviewDetails.type,
        link: interviewDetails.type === 'Virtual' 
          ? interviewDetails.link 
          : enterprise.location,
        notes: interviewDetails.notes
      },
      evaluation: {
        predictedScore: predictionRes.data.predictedScore
      },
      mlFeatures: predictionRes.data.features
    };

    const response = await axios.post('http://localhost:3001/api/interviews/', interviewData);

    alert(`Interview scheduled successfully! Predicted score: ${Math.round(predictionRes.data.predictedScore * 100)}/100. The candidate will receive a confirmation email.`);
    
    setShowInterviewModal(false);
    setInterviewDetails({
      type: 'Virtual',
      link: '',
      date: '',
      time: '',
      notes: ''
    });
    
    fetchInterviews(selectedJobId);
  } catch (error) {
    console.error('Error scheduling interview:', error);
    alert(`Failed to schedule interview: ${error.response?.data?.message || error.message}`);
  }
};

  const handlePasswordChange = async () => {
    if (!passwordData.newPassword || !passwordData.confirmPassword) {
      alert("Please fill in both password fields.");
      return;
    }
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      alert("Passwords do not match!");
      return;
    }
    if (passwordData.newPassword.length < 5) {
      alert("Password must be at least 5 characters long.");
      return;
    }

    try {
      await axios.put(`http://localhost:3001/Frontend/updateUser/${id}`, {
        password: passwordData.newPassword
      });
      alert("Password updated successfully!");
      setPasswordData({ newPassword: "", confirmPassword: "" });
    } catch (error) {
      console.error("Error updating password:", error);
      alert("Failed to update password.");
    }
  };

  const handleManualGradeAnswer = async ({ jobId, candidateId, questionIndex, isCorrect }) => {
    try {
      const normalizedJobId = normalizeMongoId(jobId);
      const normalizedCandidateId = normalizeMongoId(candidateId);

      const response = await axios.put("http://localhost:3001/Frontend/manual-grade-quiz-answer", {
        jobId: normalizedJobId,
        candidateId: normalizedCandidateId,
        questionIndex,
        isCorrect,
      });

      const newScore = Number(response?.data?.quizScore || 0);
      const pendingCount = Number(response?.data?.reviewRequiredCount || 0);

      setSelectedApplications((prev) =>
        prev.map((application) => {
          const appCandidateId = normalizeMongoId(application?.candidateId);
          const appJobId = normalizeMongoId(application?.jobId);
          if (appJobId !== normalizedJobId || appCandidateId !== normalizedCandidateId) {
            return application;
          }

          const updatedAnswers = Array.isArray(application.quizAnswers)
            ? application.quizAnswers.map((answer) =>
                Number(answer.questionIndex) === Number(questionIndex)
                  ? {
                      ...answer,
                      isCorrect,
                      needsHumanReview: false,
                      evaluationMode: "rh-manual",
                    }
                  : answer
              )
            : [];

          const quizLength = Number(application.quizLength || updatedAnswers.length || 0);
          const passingScore = quizLength ? Math.ceil(quizLength / 2) : 0;

          return {
            ...application,
            quizAnswers: updatedAnswers,
            quizScore: newScore,
            quizReviewPendingCount: pendingCount,
            quizPercent: quizLength ? Math.round((newScore / quizLength) * 100) : 0,
            isQualified: quizLength ? newScore >= passingScore : false,
          };
        })
      );
    } catch (error) {
      console.error("Error while manually grading answer:", error);
      alert(error?.response?.data?.message || "Failed to save manual grading.");
    }
  };

  const handleAiGradeAnswer = async ({ jobId, candidateId, questionIndex }) => {
    try {
      const normalizedJobId = normalizeMongoId(jobId);
      const normalizedCandidateId = normalizeMongoId(candidateId);

      const response = await axios.put("http://localhost:3001/Frontend/ai-grade-quiz-answer", {
        jobId: normalizedJobId,
        candidateId: normalizedCandidateId,
        questionIndex,
      });

      const newScore = Number(response?.data?.quizScore || 0);
      const pendingCount = Number(response?.data?.reviewRequiredCount || 0);
      const updatedAnswer = response?.data?.updatedAnswer || null;

      setSelectedApplications((prev) =>
        prev.map((application) => {
          const appCandidateId = normalizeMongoId(application?.candidateId);
          const appJobId = normalizeMongoId(application?.jobId);
          if (appJobId !== normalizedJobId || appCandidateId !== normalizedCandidateId) {
            return application;
          }

          const updatedAnswers = Array.isArray(application.quizAnswers)
            ? application.quizAnswers.map((answer) =>
                Number(answer.questionIndex) === Number(questionIndex)
                  ? {
                      ...answer,
                      ...(updatedAnswer || {}),
                    }
                  : answer
              )
            : [];

          const quizLength = Number(application.quizLength || updatedAnswers.length || 0);
          const passingScore = quizLength ? Math.ceil(quizLength / 2) : 0;

          return {
            ...application,
            quizAnswers: updatedAnswers,
            quizScore: newScore,
            quizReviewPendingCount: pendingCount,
            quizPercent: quizLength ? Math.round((newScore / quizLength) * 100) : 0,
            isQualified: quizLength ? newScore >= passingScore : false,
          };
        })
      );
    } catch (error) {
      console.error("Error while AI grading answer:", error);
      alert(error?.response?.data?.message || "Failed to run AI grading.");
    }
  };

  const handleChooseImage = () => fileInputRef.current.click();

  const handleCancelImage = () => {
    setImagePreview(null);
    setSelectedFile(null);
  };

  const handleEdit = () => setIsEditing(true);

  const handleCancelEdit = () => {
    setEditedEnterprise(enterprise);
    setImagePreview(null);
    setSelectedFile(null);
    setIsEditing(false);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setEditedEnterprise((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    try {
      const res = await axios.put(`http://localhost:3001/Frontend/updateUser/${id}`, {
        enterprise: editedEnterprise,
      });

      setEnterprise(res.data.enterprise);
      setIsEditing(false);
      setUserPicture(res.data.picture || userPicture);

      if (selectedFile) {
        const formData = new FormData();
        formData.append("picture", selectedFile);
        formData.append("userId", id);

        const uploadRes = await axios.post(
          "http://localhost:3001/Frontend/upload-profile",
          formData,
          {
            headers: { "Content-Type": "multipart/form-data" },
          }
        );

        if (uploadRes.data.pictureUrl) {
          setUserPicture(uploadRes.data.pictureUrl);
        }
      }

      setImagePreview(null);
      setSelectedFile(null);
    } catch (error) {
      console.error("Error updating profile:", error);
    }
  };

  const handleSubmitQuiz = async () => {
    if (!selectedQuizCandidateId) {
      alert("Please select a candidate before saving quiz.");
      return;
    }

    try {
      await axios.post("http://localhost:3001/Frontend/save-candidate-quiz", {
        jobId: quizJobId,
        candidateId: selectedQuizCandidateId,
        questions: quizQuestions,
        source: generationInfo?.source || "manual",
      });
      setJobCandidatesForQuiz((prev) =>
        prev.map((candidate) =>
          String(candidate.candidateId) === String(selectedQuizCandidateId)
            ? { ...candidate, hasQuiz: true, quizQuestionCount: quizQuestions.length }
            : candidate
        )
      );
      alert("🎉 Candidate quiz saved successfully!");
    } catch (error) {
      console.error("Error saving quiz:", error);
      alert("Failed to save quiz. Please try again.");
    }
  };

  const handleJobChange = (e) => {
    const { name, value } = e.target;
    setNewJob((prev) => ({ ...prev, [name]: value }));
  };

  const addToken = (field, value) => {
    const normalizedValue = value.trim();
    if (!normalizedValue) return;

    if (field === "languages") {
      setSelectedLanguages((prev) => {
        if (prev.some((item) => item.toLowerCase() === normalizedValue.toLowerCase())) return prev;
        const updated = [...prev, normalizedValue];
        setNewJob((prevJob) => ({ ...prevJob, languages: updated.join(", ") }));
        return updated;
      });
      setLanguageInput("");
      return;
    }

    setSelectedSkills((prev) => {
      if (prev.some((item) => item.toLowerCase() === normalizedValue.toLowerCase())) return prev;
      const updated = [...prev, normalizedValue];
      setNewJob((prevJob) => ({ ...prevJob, skills: updated.join(", ") }));
      return updated;
    });
    setSkillInput("");
  };

  const removeToken = (field, token) => {
    if (field === "languages") {
      setSelectedLanguages((prev) => {
        const updated = prev.filter((item) => item !== token);
        setNewJob((prevJob) => ({ ...prevJob, languages: updated.join(", ") }));
        return updated;
      });
      return;
    }

    setSelectedSkills((prev) => {
      const updated = prev.filter((item) => item !== token);
      setNewJob((prevJob) => ({ ...prevJob, skills: updated.join(", ") }));
      return updated;
    });
  };

  const handleTokenKeyDown = (event, field) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addToken(field, field === "languages" ? languageInput : skillInput);
    }
  };

  const filteredLanguageSuggestions = languageSuggestions.filter(
    (language) =>
      language.toLowerCase().includes(languageInput.toLowerCase()) &&
      !selectedLanguages.some((item) => item.toLowerCase() === language.toLowerCase())
  );

  const filteredSkillSuggestions = skillSuggestions.filter(
    (skill) =>
      skill.toLowerCase().includes(skillInput.toLowerCase()) &&
      !selectedSkills.some((item) => item.toLowerCase() === skill.toLowerCase())
  );

  const resetJobForm = () => {
    setNewJob({
      title: "",
      description: "",
      location: "",
      salary: "",
      languages: "",
      skills: "",
    });
    setSelectedLanguages([]);
    setSelectedSkills([]);
    setLanguageInput("");
    setSkillInput("");
    setShowJobForm(false);
  };

  const handleSubmitJob = async () => {
    try {
      const payload = {
        title: newJob.title,
        description: newJob.description,
        location: newJob.location,
        salary: newJob.salary,
        skills: newJob.skills.split(",").map((skill) => skill.trim()),
        languages: newJob.languages.split(",").map((lang) => lang.trim()),
        entrepriseId: id,
      };

      await axios.post("http://localhost:3001/Frontend/add-job", payload);

      const res = await axios.get(`http://localhost:3001/Frontend/jobs-by-entreprise/${id}`);
      setEnterpriseJobs(res.data);

      alert("New job added successfully!");
      resetJobForm();
    } catch (err) {
      console.error("Error saving job:", err);
      alert(err?.response?.data?.message || "Failed to save job.");
    }
  };

  return (
    <PublicLayout>
      <div className="entreprise-profile-container">
        <div className="entreprise-profile">
          {loading ? (
            <div className="text-center">
              <div className="loading-spinner">
                <div className="spinner-border text-light" role="status">
                  <span className="visually-hidden">Loading...</span>
                </div>
              </div>
            </div>
          ) : !enterprise ? (
            <div className="alert alert-danger" role="alert">
              No data found for this enterprise.
            </div>
          ) : (
            <>
              <div className="profile-header">
                <div>
                  <h2 className="profile-title">
                    <FontAwesomeIcon icon={faBuilding} className="title-icon" />
                    My Enterprise Profile
                  </h2>
                  <p className="profile-subtitle">
                    Manage your company presence, job posts, and candidate pipeline in one place.
                  </p>
                </div>
                {!isEditing && (
                  <button className="btn btn-edit-profile" onClick={handleEdit}>
                    <FontAwesomeIcon icon={faEdit} /> Edit
                  </button>
                )}
              </div>

              <div className="profile-overview-stats">
                <div className="overview-chip">
                  <span className="chip-label">Posted Jobs</span>
                  <span className="chip-value">{enterpriseJobs.length}</span>
                </div>
                <div className="overview-chip">
                  <span className="chip-label">Applications</span>
                  <span className="chip-value">{totalApplications}</span>
                </div>
                <div className="overview-chip">
                  <span className="chip-label">Interviews</span>
                  <span className="chip-value">{scheduledInterviews.length}</span>
                </div>
              </div>

              <div className="profile-content">
                <div className="profile-sidebar">
                  <div className="image-upload-container">
                    {userPicture && !imagePreview ? (
                      <div className="enterprise-image-wrapper">
                        <img
                          src={`http://localhost:3001${userPicture}`}
                          alt={enterprise.name}
                          className="enterprise-image"
                        />
                        {isEditing && (
                          <div className="image-overlay" onClick={handleChooseImage}>
                            <FontAwesomeIcon icon={faCamera} className="camera-icon" />
                          </div>
                        )}
                      </div>
                    ) : !userPicture && !imagePreview ? (
                      <div
                        className={`image-placeholder ${isEditing ? "editable" : ""}`}
                        onClick={isEditing ? handleChooseImage : null}
                      >
                        <FontAwesomeIcon icon={faCamera} className="camera-icon" />
                        <span>Add image</span>
                      </div>
                    ) : (
                      <div className="enterprise-image-wrapper">
                        <img src={imagePreview} alt="Preview" className="enterprise-image" />
                        <div className="image-actions">
                          <button className="btn btn-success btn-sm" onClick={handleSave}>
                            <FontAwesomeIcon icon={faSave} />
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={handleCancelImage}>
                            <FontAwesomeIcon icon={faTimes} />
                          </button>
                        </div>
                      </div>
                    )}

                    <input
                      type="file"
                      accept="image/*"
                      ref={fileInputRef}
                      style={{ display: "none" }}
                      onChange={handleImageChange}
                    />
                  </div>

                  <button
                    className="btn btn-add-job mt-4 w-100"
                    onClick={() => {
                      if (showJobForm) {
                        resetJobForm();
                      } else {
                        setShowJobForm(true);
                      }
                    }}
                  >
                    <FontAwesomeIcon icon={showJobForm ? faMinus : faPlus} className="me-2" />
                    {showJobForm ? "Hide" : "Add Job"}
                  </button>
                </div>

                <div className="profile-details">
                  <div className="profile-card">
                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faBuilding} className="detail-icon" />
                      <div className="detail-content">
                        <label>Name</label>
                        {isEditing ? (
                          <input
                            name="name"
                            className="form-control"
                            value={editedEnterprise.name || ""}
                            onChange={handleChange}
                          />
                        ) : (
                          <p>{enterprise.name}</p>
                        )}
                      </div>
                    </div>

                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faIndustry} className="detail-icon" />
                      <div className="detail-content">
                        <label>Industry</label>
                        {isEditing ? (
                          <input
                            name="industry"
                            className="form-control"
                            value={editedEnterprise.industry || ""}
                            onChange={handleChange}
                          />
                        ) : (
                          <p>{enterprise.industry}</p>
                        )}
                      </div>
                    </div>

                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faLocationDot} className="detail-icon" />
                      <div className="detail-content">
                        <label>Location</label>
                        {isEditing ? (
                          <input
                            name="location"
                            className="form-control"
                            value={editedEnterprise.location || ""}
                            onChange={handleChange}
                          />
                        ) : (
                          <p>{enterprise.location}</p>
                        )}
                      </div>
                    </div>

                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faGlobe} className="detail-icon" />
                      <div className="detail-content">
                        <label>Website</label>
                        {isEditing ? (
                          <input
                            name="website"
                            className="form-control"
                            value={editedEnterprise.website || ""}
                            onChange={handleChange}
                          />
                        ) : (
                          <p>
                            <a href={enterprise.website} target="_blank" rel="noreferrer">
                              {enterprise.website}
                            </a>
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faPeopleGroup} className="detail-icon" />
                      <div className="detail-content">
                        <label>Employee Count</label>
                        {isEditing ? (
                          <input
                            name="employeeCount"
                            type="number"
                            className="form-control"
                            value={editedEnterprise.employeeCount || ""}
                            onChange={handleChange}
                          />
                        ) : (
                          <p>{enterprise.employeeCount}</p>
                        )}
                      </div>
                    </div>

                    <div className="profile-detail description-detail">
                      <FontAwesomeIcon icon={faFileLines} className="detail-icon" />
                      <div className="detail-content">
                        <label>Description</label>
                        {isEditing ? (
                          <textarea
                            name="description"
                            className="form-control"
                            value={editedEnterprise.description || ""}
                            onChange={handleChange}
                            rows="4"
                          />
                        ) : (
                          <p>{enterprise.description}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="profile-card mt-4">
                    <h4 className="mb-4" style={{ color: '#2c3e50', fontSize: '1.2rem', fontWeight: '600', borderBottom: '2px solid #e9ecef', paddingBottom: '10px' }}>
                      <FontAwesomeIcon icon={faLock} className="me-2 text-primary" />
                      Account Settings
                    </h4>
                    
                    <div className="profile-detail">
                      <FontAwesomeIcon icon={faEnvelope} className="detail-icon" />
                      <div className="detail-content">
                        <label>Registered Email</label>
                        <p className="text-dark fw-bold">{userEmail}</p>
                      </div>
                    </div>

                    <div className="password-change-section mt-3 p-3 rounded" style={{ backgroundColor: '#f8f9fa', border: '1px solid #e9ecef' }}>
                      <h6 className="mb-3 d-flex align-items-center">
                        <FontAwesomeIcon icon={faKey} className="me-2 text-warning" />
                        Change Password
                      </h6>
                      <div className="row g-2 align-items-end">
                        <div className="col-md-5">
                          <label className="form-label small text-muted">New Password</label>
                          <input 
                            type="password" 
                            className="form-control form-control-sm"
                            placeholder="Enter new password"
                            value={passwordData.newPassword}
                            onChange={(e) => setPasswordData({...passwordData, newPassword: e.target.value})}
                          />
                        </div>
                        <div className="col-md-5">
                          <label className="form-label small text-muted">Confirm Password</label>
                          <input 
                            type="password" 
                            className="form-control form-control-sm"
                            placeholder="Repeat password"
                            value={passwordData.confirmPassword}
                            onChange={(e) => setPasswordData({...passwordData, confirmPassword: e.target.value})}
                          />
                        </div>
                        <div className="col-md-2">
                          <button 
                            className="btn btn-primary btn-sm w-100"
                            onClick={handlePasswordChange}
                            disabled={!passwordData.newPassword || !passwordData.confirmPassword}
                          >
                            Update
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="profile-actions">
                      <button className="btn btn-save" onClick={handleSave}>
                        <FontAwesomeIcon icon={faSave} className="me-2" />
                        Save
                      </button>
                      <button className="btn btn-cancel" onClick={handleCancelEdit}>
                        <FontAwesomeIcon icon={faTimes} className="me-2" />
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {showJobForm && (
                <div className="job-form">
                  <h4 className="mb-4">
                    <FontAwesomeIcon icon={faBriefcase} className="me-2" />
                    New Job Position
                  </h4>
                  <div className="mb-3">
                    <label className="form-label">Job Title</label>
                    <input
                      type="text"
                      className="form-control"
                      name="title"
                      value={newJob.title}
                      onChange={handleJobChange}
                      placeholder="Ex: React Frontend Developer"
                    />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Description</label>
                    <textarea
                      className="form-control"
                      name="description"
                      value={newJob.description}
                      onChange={handleJobChange}
                      placeholder="Describe responsibilities and required qualifications"
                      rows="4"
                    ></textarea>
                  </div>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label">Location</label>
                      <input
                        type="text"
                        className="form-control"
                        name="location"
                        value={newJob.location}
                        onChange={handleJobChange}
                        placeholder="Ex: Paris, France"
                      />
                    </div>
                    <div className="col-md-6 mb-3">
                      <label className="form-label">Salary (€)</label>
                      <input
                        type="number"
                        className="form-control"
                        name="salary"
                        value={newJob.salary}
                        onChange={handleJobChange}
                        placeholder="Ex: 45000"
                      />
                    </div>
                  </div>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label">Required Languages</label>
                      <div className="ticket-input-container">
                        <div className="ticket-list">
                          {selectedLanguages.map((language) => (
                            <span key={language} className="ticket-item">
                              {language}
                              <button type="button" onClick={() => removeToken("languages", language)}>×</button>
                            </span>
                          ))}
                          <input
                            type="text"
                            className="ticket-input"
                            value={languageInput}
                            onChange={(e) => setLanguageInput(e.target.value)}
                            onKeyDown={(e) => handleTokenKeyDown(e, "languages")}
                            placeholder="Type and press Enter"
                          />
                        </div>
                        {(languageInput || filteredLanguageSuggestions.length > 0) && (
                          <div className="suggestions-menu">
                            {filteredLanguageSuggestions.length > 0 ? (
                              filteredLanguageSuggestions.map((language) => (
                                <button
                                  type="button"
                                  key={language}
                                  className="suggestion-item"
                                  onClick={() => addToken("languages", language)}
                                >
                                  {language}
                                </button>
                              ))
                            ) : (
                              <button
                                type="button"
                                className="suggestion-item add-custom"
                                onClick={() => addToken("languages", languageInput)}
                              >
                                Add "{languageInput}"
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="col-md-6 mb-3">
                      <label className="form-label">Required Skills</label>
                      <div className="ticket-input-container">
                        <div className="ticket-list">
                          {selectedSkills.map((skill) => (
                            <span key={skill} className="ticket-item">
                              {skill}
                              <button type="button" onClick={() => removeToken("skills", skill)}>×</button>
                            </span>
                          ))}
                          <input
                            type="text"
                            className="ticket-input"
                            value={skillInput}
                            onChange={(e) => setSkillInput(e.target.value)}
                            onKeyDown={(e) => handleTokenKeyDown(e, "skills")}
                            placeholder="Type and press Enter"
                          />
                        </div>
                        {(skillInput || filteredSkillSuggestions.length > 0) && (
                          <div className="suggestions-menu">
                            {filteredSkillSuggestions.length > 0 ? (
                              filteredSkillSuggestions.map((skill) => (
                                <button
                                  type="button"
                                  key={skill}
                                  className="suggestion-item"
                                  onClick={() => addToken("skills", skill)}
                                >
                                  {skill}
                                </button>
                              ))
                            ) : (
                              <button
                                type="button"
                                className="suggestion-item add-custom"
                                onClick={() => addToken("skills", skillInput)}
                              >
                                Add "{skillInput}"
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-end mt-4">
                    <button
                      className="btn btn-success"
                      onClick={handleSubmitJob}
                      disabled={!newJob.title || !newJob.description}
                    >
                      <FontAwesomeIcon icon={faPlusCircle} className="me-2" />
                      Add
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {enterpriseJobs.length > 0 && (
          <div className="jobs-section mt-5">
            <div className="jobs-section-title-row">
              <h4 className="mb-4">
                <i className="fas fa-briefcase icon"></i>Jobs posted by your company
              </h4>
              <span className="jobs-count-pill">{activeJobsCount} Active • {archivedJobsCount} Archived</span>
            </div>
            <div className="jobs-grid">
              {activeJobs.map((job, index) => {
                const cleanedDescription = typeof job.description === "string" ? job.description.trim() : "";
                const hasDescription = cleanedDescription.length > 0;
                const isEditingThisCard = editingJobCardId === job._id;

                return (
                <div key={job._id} className="job-card" style={{ animationDelay: `${index * 0.1}s` }}>
                  <div className="card-header d-flex justify-content-between align-items-start gap-3">
                    <h5 className="card-title">
                      <span className="card-title-text">{job.title}</span>
                    </h5>

                    <div className="job-card-header-actions">
                      {applicationCounts[job._id] > 0 && (
                        <button
                          type="button"
                          className="view-applications-btn"
                          onClick={() => openApplicationModal(job._id)}
                          title="View applications"
                        >
                          <span>View Applications</span>
                          <span className="notif-count">{applicationCounts[job._id]}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        className="delete-job-btn"
                        onClick={() => handleDeleteJob(job._id)}
                        title="Delete this job"
                      >
                        <FontAwesomeIcon icon={faTrashCan} />
                      </button>
                    </div>
                  </div>

                  <div className="job-meta-row">
                    <span className="meta-pill">
                      <i className="fas fa-map-marker-alt me-2"></i>{job.location || "Remote"}
                    </span>
                    <span className="meta-pill salary-pill">{job.salary ? `${job.salary} €` : "Salary N/A"}</span>
                  </div>

                  <div className="job-action-row mb-3">
                    <button
                      className="btn btn-sm btn-outline-info"
                      onClick={() => handleEditJob(job)}
                    >
                      <FontAwesomeIcon icon={faEdit} className="me-1" /> Modify
                    </button>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() => handleArchiveJob(job._id)}
                    >
                      <FontAwesomeIcon icon={faBoxArchive} className="me-1" /> Archive
                    </button>
                  </div>

                  {isEditingThisCard && (
                    <div className="job-inline-editor mb-3">
                      <div className="row g-2">
                        <div className="col-md-6">
                          <label className="form-label">Title</label>
                          <input
                            type="text"
                            className="form-control"
                            name="title"
                            value={editingJobCardData.title}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                        <div className="col-md-3">
                          <label className="form-label">Location</label>
                          <input
                            type="text"
                            className="form-control"
                            name="location"
                            value={editingJobCardData.location}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                        <div className="col-md-3">
                          <label className="form-label">Salary (€)</label>
                          <input
                            type="number"
                            className="form-control"
                            name="salary"
                            value={editingJobCardData.salary}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                        <div className="col-12">
                          <label className="form-label">Description</label>
                          <textarea
                            className="form-control"
                            rows="3"
                            name="description"
                            value={editingJobCardData.description}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label">Languages (comma separated)</label>
                          <input
                            type="text"
                            className="form-control"
                            name="languages"
                            value={editingJobCardData.languages}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label">Skills (comma separated)</label>
                          <input
                            type="text"
                            className="form-control"
                            name="skills"
                            value={editingJobCardData.skills}
                            onChange={handleEditJobCardChange}
                          />
                        </div>
                      </div>
                      <div className="d-flex gap-2 mt-3 justify-content-end">
                        <button
                          className="btn btn-sm btn-success"
                          onClick={() => handleSaveEditJobCard(job._id)}
                          disabled={!editingJobCardData.title || !editingJobCardData.description}
                        >
                          <FontAwesomeIcon icon={faSave} className="me-1" /> Save
                        </button>
                        <button className="btn btn-sm btn-outline-light" onClick={handleCancelEditJobCard}>
                          <FontAwesomeIcon icon={faTimes} className="me-1" /> Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="card-body">
                    <div className="job-detail job-description">
                      <strong className="job-description-label">Description:</strong>
                      <div className="job-description-content">
                        <p className={`job-description-text ${hasDescription ? "" : "is-empty"}`}>
                          {hasDescription ? cleanedDescription : "No description provided for this job yet."}
                        </p>
                      </div>
                    </div>
                    {job.languages?.length > 0 && (
                      <div className="job-detail">
                        <strong>Languages:</strong>
                        <div className="tag-container">
                          {job.languages.map((lang, i) => (
                            <span key={i} className="language-tag">
                              <i className="fas fa-language"></i> {lang}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {job.skills?.length > 0 && (
                      <div className="job-detail">
                        <strong>Skills:</strong>
                        <div className="tag-container">
                          {job.skills.map((skill, i) => (
                            <span key={i} className="skill-tag">
                              <i className="fas fa-code"></i> {skill}
                            </span>
                          ))}
                          <button
                            className="btn btn-outline-warning mt-2"
                            onClick={() => openQuizFormModal(job._id)}
                            disabled={job.status === "CLOSED" || isEditingThisCard}
                          >
                            {jobQuizLengths[job._id] ? `Edit Quiz (${jobQuizLengths[job._id]} questions)` : "Add Quiz"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );})}
            </div>

            {archivedJobs.length > 0 && (
              <div className="mt-4">
                <h5 className="mb-3">Archived Jobs</h5>
                <div className="jobs-grid">
                  {archivedJobs.map((job, index) => (
                    <div key={`archived-${job._id}`} className="job-card" style={{ animationDelay: `${index * 0.05}s` }}>
                      <div className="card-header d-flex justify-content-between align-items-start gap-3">
                        <h5 className="card-title">
                          <span className="card-title-text">{job.title}</span>
                          <span className="job-status-badge is-archived">Archived</span>
                        </h5>
                        <button
                          className="btn btn-sm btn-outline-success"
                          onClick={() => handleUnarchiveJob(job._id)}
                        >
                          <FontAwesomeIcon icon={faRotateLeft} className="me-1" /> Unarchive
                        </button>
                      </div>
                      <div className="card-body">
                        <div className="job-detail">
                          <strong><i className="fas fa-map-marker-alt me-2"></i>Location:</strong> {job.location || "Remote"}
                        </div>
                        <div className="job-detail">
                          <strong>Salary:</strong> {job.salary ? `${job.salary} €` : "Salary N/A"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

{showModal && (
  <div className="custom-modal-overlay">
    <div className="custom-modal">
      <div className="modal-header">
        <h5>Candidates Quiz Insights (All Applicants)</h5>
        <button className="close-button" onClick={() => setShowModal(false)}>
          ✖
        </button>
      </div>
      <div className="modal-body">
        {selectedApplications.length > 0 ? (
          selectedApplications.map((app) => {
            const quizPercent = app.quizPercent || 0;
            const candidateName = app.candidateId?.name || "Candidate";
            const candidateInitial = candidateName.charAt(0).toUpperCase();

            return (
              <div key={app._id || app.candidateId?._id || app.candidateId?.email} className="application-card">
                <div className="application-card-header">
                  <div className="candidate-identity">
                    <div className="candidate-avatar">{candidateInitial}</div>
                    <div className="candidate-text">
                      <h6>{candidateName}</h6>
                      <p>{app.candidateId?.email}</p>
                    </div>
                  </div>

                  <div className="candidate-badges">
                    <span className="status-pill status-pill-quiz">Quiz {quizPercent}%</span>
                    <span className={`status-pill ${app.isQualified ? "status-pill-recommended" : "status-pill-not-recommended"}`}>
                      {app.isQualified ? "Qualified" : "Not Qualified"}
                    </span>
                    {app.mlPrediction && (
                      <span className={`status-pill ${app.mlPrediction.hired ? "status-pill-recommended" : "status-pill-not-recommended"}`}>
                        {app.mlPrediction.hired ? "Recommended" : "Not Recommended"} ({app.mlPrediction.confidence}%)
                      </span>
                    )}
                  </div>
                </div>

                <div className="candidate-details-grid">
                  <div className="detail-item">
                    <span className="detail-label">Phone</span>
                    <span className="detail-value">{app.candidateId?.profile?.phone || "Not available"}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Quiz Score</span>
                    <span className="detail-value">{app.quizScore}/{app.quizLength} ({quizPercent}%)</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Quiz Time</span>
                    <span className="detail-value">{formatQuizDuration(app.quizTimeSpentSeconds)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">RH Review</span>
                    <span className="detail-value">{Number(app.quizReviewPendingCount || 0)} pending</span>
                  </div>
                  <div className="detail-item detail-item-full">
                    <span className="detail-label">Qualification</span>
                    <span className="qualified-text">
                      {app.isQualified ? "✅ Qualified" : "❌ Not Qualified"} (Needed {app.passingScore} correct answers)
                    </span>
                  </div>
                  <div className="detail-item detail-item-full">
                    <span className="detail-label">Why this quiz was generated</span>
                    <span className="detail-value">{app.quizRationale || "Generated from candidate profile and job requirements."}</span>
                  </div>
                </div>

                {Array.isArray(app.quizSkillsUsed) && app.quizSkillsUsed.length > 0 && (
                  <div className="match-details">
                    <div className="match-item" style={{ width: "100%" }}>
                      <span>Skills used by model</span>
                      <strong>{app.quizSkillsUsed.join(", ")}</strong>
                    </div>
                  </div>
                )}

                {Array.isArray(app.quizAnswers) && app.quizAnswers.length > 0 && (
                  <details className="mb-3">
                    <summary className="fw-semibold">View submitted answers ({app.quizAnswers.length})</summary>
                    <div className="mt-2">
                      {app.quizAnswers.map((answer, index) => (
                        <div key={`${app._id || app.candidateId?._id}-answer-${index}`} className="p-3 border rounded mb-3" style={{ backgroundColor: answer.isCorrect ? "#f0f8f7" : answer.needsHumanReview ? "#fffbf0" : "#fef5f5" }}>
                          <div className="mb-2"><strong>Q{answer.questionIndex + 1}:</strong> {answer.question || "Question"}</div>
                          
                          {/* Answer Comparison Section */}
                          <div className="row g-2 mb-3">
                            {/* User's Answer */}
                            <div className="col-md-6">
                              <div className="p-2 border rounded" style={{ backgroundColor: "#f9f9f9" }}>
                                <div><small className="text-muted">👤 User's Answer:</small></div>
                                <div className="mt-1">{answer.selectedAnswerText || (answer.selectedAnswerIndex !== null && answer.selectedAnswerIndex !== undefined ? `Option ${Number(answer.selectedAnswerIndex) + 1}` : "No answer")}
                                </div>
                              </div>
                            </div>
                            
                            {/* Expected Answer */}
                            <div className="col-md-6">
                              <div className="p-2 border rounded" style={{ backgroundColor: "#f0f9f7" }}>
                                <div><small className="text-muted">✓ Correct Answer:</small></div>
                                <div className="mt-1">{answer.expectedAnswer || "N/A"}</div>
                              </div>
                            </div>
                          </div>

                          {/* AI Assessment Result */}
                          <div className="d-flex align-items-center justify-content-between mb-2">
                            <div>
                              <strong>AI Assessment:</strong> {answer.isCorrect ? "✅ Correct" : "❌ Incorrect"}
                              {answer.needsHumanReview && " • 🟡 Needs RH Review"}
                              {answer.evaluationMode === "rh-manual" && " • 👤 RH Validated"}
                            </div>
                            {typeof answer.aiConfidence === "number" && (
                              <span className="badge" style={{ backgroundColor: answer.aiConfidence > 70 ? "#198754" : answer.aiConfidence > 40 ? "#ffc107" : "#dc3545" }}>
                                Confidence: {answer.aiConfidence}%
                              </span>
                            )}
                          </div>

                          {answer.needsHumanReview && (
                            <div className="alert alert-warning py-2 mb-2 small">
                              ⚠️ AI is uncertain about this answer. As RH, please review and confirm if user's answer is correct or incorrect.
                            </div>
                          )}
                          {(answer.questionType === "réponse courte" || answer.questionType === "mini-exercice") && (
                            <div className="d-flex gap-2 mt-2">
                              <button
                                className="btn btn-sm btn-outline-primary"
                                type="button"
                                onClick={() =>
                                  handleAiGradeAnswer({
                                    jobId: normalizeMongoId(app.jobId),
                                    candidateId: normalizeMongoId(app.candidateId),
                                    questionIndex: Number(answer.questionIndex),
                                  })
                                }
                              >
                                AI Check
                              </button>
                              <button
                                className="btn btn-sm btn-outline-success"
                                type="button"
                                onClick={() =>
                                  handleManualGradeAnswer({
                                    jobId: normalizeMongoId(app.jobId),
                                    candidateId: normalizeMongoId(app.candidateId),
                                    questionIndex: Number(answer.questionIndex),
                                    isCorrect: true,
                                  })
                                }
                              >
                                Mark Correct
                              </button>
                              <button
                                className="btn btn-sm btn-outline-danger"
                                type="button"
                                onClick={() =>
                                  handleManualGradeAnswer({
                                    jobId: normalizeMongoId(app.jobId),
                                    candidateId: normalizeMongoId(app.candidateId),
                                    questionIndex: Number(answer.questionIndex),
                                    isCorrect: false,
                                  })
                                }
                              >
                                Mark Incorrect
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {app.mlPrediction && (
                  <div className="match-details">
                    <div className="match-item">
                      <span>Skill Match</span>
                      <strong>{Math.round(app.mlPrediction.matches.skill_match * 100)}%</strong>
                    </div>
                    <div className="match-item">
                      <span>Experience Match</span>
                      <strong>{Math.round(app.mlPrediction.matches.exp_match * 100)}%</strong>
                    </div>
                    <div className="match-item">
                      <span>Education Match</span>
                      <strong>{Math.round(app.mlPrediction.matches.education_match * 100)}%</strong>
                    </div>
                  </div>
                )}

                <div className="action-buttons">
                  <button
                    className="btn btn-primary"
                    onClick={() => handleScheduleInterview(app)}
                  >
                    <FontAwesomeIcon icon={faCalendarAlt} className="me-2" />
                    Schedule Interview
                  </button>
                  <a
                    href={`mailto:${app.candidateId?.email}`}
                    className="btn btn-outline-primary"
                  >
                    📧 Send email
                  </a>
                  {app.candidateId?.profile?.phone && (
                    <a
                      href={`tel:${app.candidateId.profile.phone}`}
                      className="btn btn-outline-success"
                    >
                      📞 Call
                    </a>
                  )}
                  {app.cv && (
                    <a
                      href={`http://localhost:3001${app.cv}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-outline-secondary"
                    >
                      📄 Download CV
                    </a>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="alert alert-info">
            No generated quizzes found for this job yet.
          </div>
        )}
      </div>
    </div>
  </div>
)}

        {/* Scheduled Interviews Section */}
        {scheduledInterviews.length > 0 && (
  <div className="interviews-section mt-5">
    <h4 className="mb-4">
      <FontAwesomeIcon icon={faCalendarAlt} className="me-2" />
      Scheduled Interviews
    </h4>
    <div className="interview-list">
      {scheduledInterviews.map((interview, index) => (
        <div key={index} className="interview-card">
          <div className="interview-header">
            <h6>
              <FontAwesomeIcon icon={faVideo} className="me-2" />
              Interview with {interview.candidateId?.name}
            </h6>
            <span className={`status-badge ${interview.status.toLowerCase()}`}>
              {interview.status}
            </span>
          </div>
          <div className="interview-details">
            <p>
              <strong>Date:</strong> {new Date(interview.date).toLocaleString()}
            </p>
            <p>
              <strong>Type:</strong> {interview.meeting.type}
            </p>
            {interview.evaluation?.predictedScore && (
              <p>
                <strong>Predicted Score:</strong> 
                <span className="score-badge">
                  {Math.round(interview.evaluation.predictedScore * 100)}/100
                </span>
              </p>
            )}
            {interview.meeting.type === 'Virtual' && (
              <p>
                <strong>Link:</strong> 
                <a 
                  href={interview.meeting.link} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="interview-link"
                >
                  {interview.meeting.link}
                </a>
              </p>
            )}
            {interview.meeting.notes && (
              <p>
                <strong>Notes:</strong> {interview.meeting.notes}
              </p>
            )}
          </div>
          <div className="interview-actions">
            {interview.meeting.type === 'Virtual' && (
              <a 
                href={interview.meeting.link} 
                target="_blank" 
                rel="noopener noreferrer"
                className="btn btn-sm btn-primary"
              >
                <FontAwesomeIcon icon={faVideo} className="me-2" />
                Join Meeting
              </a>
            )}
            {interview.status === 'Completed' && interview.evaluation?.finalScore && (
              <div className="final-score">
                <strong>Final Score:</strong>
                <span className="score-badge final">
                  {Math.round(interview.evaluation.finalScore * 100)}/100
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
)}

        {showInterviewModal && (
          <div className="custom-modal-overlay">
            <div className="custom-modal">
              <div className="modal-header">
                <h5>Schedule Interview with {selectedCandidate?.candidateId?.name}</h5>
                <button className="close-button" onClick={() => setShowInterviewModal(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                <div className="mb-3">
                  <label className="form-label">Interview Type</label>
                  <select
                    name="type"
                    className="form-select"
                    value={interviewDetails.type}
                    onChange={handleInterviewChange}
                  >
                    <option value="Virtual">Virtual</option>
                    <option value="In-person">In-person</option>
                  </select>
                </div>

                {interviewDetails.type === 'Virtual' && (
                  <div className="mb-3">
                    <label className="form-label">Meeting Link</label>
                    <input
                      type="text"
                      name="link"
                      className="form-control"
                      placeholder="Leave blank to generate a new meeting link"
                      value={interviewDetails.link}
                      onChange={handleInterviewChange}
                    />
                  </div>
                )}

                <div className="row mb-3">
                  <div className="col-md-6">
                    <label className="form-label">Date</label>
                    <input
                      type="date"
                      name="date"
                      className="form-control"
                      value={interviewDetails.date}
                      onChange={handleInterviewChange}
                      min={new Date().toISOString().split('T')[0]}
                      required
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label">Time</label>
                    <input
                      type="time"
                      name="time"
                      className="form-control"
                      value={interviewDetails.time}
                      onChange={handleInterviewChange}
                      required
                    />
                  </div>
                </div>

                <div className="mb-3">
                  <label className="form-label">Notes</label>
                  <textarea
                    name="notes"
                    className="form-control"
                    rows="3"
                    value={interviewDetails.notes}
                    onChange={handleInterviewChange}
                    placeholder="Any special instructions for the candidate"
                  ></textarea>
                </div>

                <div className="text-end">
                  <button
                    className="btn btn-primary"
                    onClick={handleSubmitInterview}
                    disabled={!interviewDetails.date || !interviewDetails.time}
                  >
                    <FontAwesomeIcon icon={faCalendarAlt} className="me-2" />
                    Schedule Interview
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showQuizFormModal && (
          <div className="quiz-modal">
            <h4>Add/Edit Quiz for this Job (Per Candidate)</h4>
            <p className="text-muted mb-3">
              The quiz will have {quizQuestions.length} questions. Candidates need to answer at least {Math.ceil(quizQuestions.length / 2)} correctly to qualify.
            </p>
            <div className="mb-3">
              <label className="form-label mb-1">Candidate</label>
              <select
                className="form-select"
                value={selectedQuizCandidateId}
                onChange={(e) => handleSelectQuizCandidate(e.target.value)}
              >
                {jobCandidatesForQuiz.length === 0 ? (
                  <option value="">No candidate applied to this job yet</option>
                ) : (
                  jobCandidatesForQuiz.map((candidate) => (
                    <option key={candidate.candidateId} value={candidate.candidateId}>
                      {candidate.name} ({candidate.email}) {candidate.hasQuiz ? `- Quiz: ${candidate.quizQuestionCount} Q` : "- No quiz yet"}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
              <div>
                <label className="form-label mb-1">Number of questions</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  className="form-control"
                  value={quizBlueprint.totalQuestions}
                  onChange={(e) =>
                    setQuizBlueprint((prev) => ({
                      ...prev,
                      totalQuestions: e.target.value,
                    }))
                  }
                />
              </div>
              <button
                className="btn btn-outline-primary"
                type="button"
                onClick={generateQuizFromBlueprint}
                disabled={isGeneratingQuiz || !selectedQuizCandidateId}
              >
                {isGeneratingQuiz ? "⏳ Generating with Mistral..." : "⚡ Generate Quiz (Mistral)"}
              </button>
            </div>
            {generationInfo && (
              <div className="quiz-generation-summary mb-2">
                <div className="small text-success mb-1">
                  Source: {generationInfo.source} • Model: {generationInfo.model || "n/a"} • Questions: {generationInfo.count}
                </div>
                <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                  <span className={`quiz-quality-badge ${generationInfo?.quality?.className || "quiz-quality-good"}`}>
                    Qualité: {generationInfo?.quality?.label || "n/a"} ({generationInfo?.quality?.score ?? "-"}/100)
                  </span>
                </div>
                <div className="quiz-generation-metrics small text-muted">
                  <span>Duplicates removed: {generationInfo?.postValidation?.semanticDuplicatesRemoved ?? 0}</span>
                  <span>Difficulty fixes: {generationInfo?.postValidation?.difficultyFixCount ?? 0}</span>
                  <span>
                    Time budget: {generationInfo?.postValidation?.timeBudget?.actualAfter ?? "-"}s / {generationInfo?.postValidation?.timeBudget?.target ?? "-"}s
                  </span>
                </div>
              </div>
            )}
            
            {quizQuestions.map((q, idx) => (
              <div key={idx} className="mb-3 p-3 border rounded">
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <label className="fw-bold">Question {idx + 1}</label>
                  <button 
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      if (quizQuestions.length > 1) {
                        setQuizQuestions(quizQuestions.filter((_, i) => i !== idx));
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
                <input
                  type="text"
                  className="form-control mb-2"
                  placeholder="Enter question"
                  value={q.title || q.question}
                  onChange={(e) => {
                    const updated = [...quizQuestions];
                    updated[idx].title = e.target.value;
                    updated[idx].question = e.target.value;
                    setQuizQuestions(updated);
                  }}
                  required
                />
                <div className="small text-muted mb-2">
                  Type: {q.type || "QCM"} • Domain: {q.domain || "general"} • Difficulty: {q.difficulty || "moyen"} • Score: {q.score || 1} • Time: {q.timeLimit || 60}s
                </div>
                
                <div className="options-container">
                  {q.options.map((opt, i) => (
                    <div key={i} className="input-group mb-2">
                      <div className="input-group-text">
                        <input
                          type="radio"
                          name={`correctAnswer-${idx}`}
                          checked={q.correctAnswer === i}
                          onChange={() => {
                            const updated = [...quizQuestions];
                            updated[idx].correctAnswer = i;
                            setQuizQuestions(updated);
                          }}
                        />
                      </div>
                      <input
                        type="text"
                        className="form-control"
                        placeholder={`Option ${i + 1}`}
                        value={opt}
                        onChange={(e) => {
                          const updated = [...quizQuestions];
                          updated[idx].options[i] = e.target.value;
                          setQuizQuestions(updated);
                        }}
                        required
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className="d-flex justify-content-between mt-3">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  if (quizQuestions.length < 20) {
                    setQuizQuestions([
                      ...quizQuestions,
                      { question: "", options: ["", "", "", ""], correctAnswer: 0 },
                    ]);
                  }
                }}
                disabled={quizQuestions.length >= 20}
              >
                ➕ Add Question (Max 20)
              </button>

              <div>
                <button
                  className="btn btn-danger me-2"
                  onClick={() => {
                    setShowQuizFormModal(false);
                    setSelectedQuizCandidateId("");
                    setJobCandidatesForQuiz([]);
                    setGenerationInfo(null);
                  }}
                >
                  Cancel
                </button>
                <button 
                  className="btn btn-success" 
                  onClick={handleSubmitQuiz}
                  disabled={!selectedQuizCandidateId || quizQuestions.some(q => !q.question || (q.type === "QCM" && q.options.some(opt => !opt)))}
                >
                  Save Candidate Quiz ({quizQuestions.length} questions)
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  );
};

export default EntrepriseProfile;