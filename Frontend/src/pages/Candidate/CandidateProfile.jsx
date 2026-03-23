import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import PublicLayout from "../../layouts/PublicLayout";
import "./CandidateProfile.css";

const CandidateProfile = () => {
  const { id } = useParams();
  const [candidate, setCandidate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchCandidate = async () => {
      try {
        const res = await axios.get(`http://localhost:3001/Frontend/getUser/${id}`);
        setCandidate(res.data);
        setLoading(false);
      } catch (err) {
        console.error("❌ Failed to fetch candidate profile:", err);
        setError("Failed to load candidate profile. Please try again later.");
        setLoading(false);
      }
    };
    
    fetchCandidate();
  }, [id]);

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>Loading profile...</p>
        </div>
      </PublicLayout>
    );
  }

  if (error) {
    return (
      <PublicLayout>
        <div className="error-message">{error}</div>
      </PublicLayout>
    );
  }

  if (!candidate) {
    return (
      <PublicLayout>
        <div className="error-message">No candidate data found</div>
      </PublicLayout>
    );
  }

  const profile = candidate.profile || {};
  const skillsCount = profile.skills?.length || 0;
  const experienceCount = profile.experience?.length || 0;
  const educationCount = profile.education?.length || 0;

  let candidateImage = null;
  if (candidate.picture) {
    if (candidate.picture.startsWith("http")) {
      candidateImage = candidate.picture;
    } else {
      const normalizedPicture = candidate.picture.startsWith("/") ? candidate.picture : `/${candidate.picture}`;
      candidateImage = `http://localhost:3001${normalizedPicture}`;
    }
  }

  return (
    <PublicLayout>
      <div className="candidate-profile-container">
      <div className="profile-header">
        {candidateImage ? (
          <img
            src={candidateImage}
            alt={candidate.name || "Candidate"}
            className="profile-avatar profile-avatar-image"
            onError={(e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <div className="profile-avatar">
            {candidate.name?.charAt(0) || "C"}
          </div>
        )}
        
        <div className="profile-title">
          <h1>{candidate.name || "Candidate"}</h1>
          <p className="headline">{profile.headline || "Professional Profile"}</p>
          <p className="profile-subtitle">Detailed candidate overview for hiring decisions</p>
        </div>
      </div>

      <div className="profile-stats-row">
        <div className="stat-chip">
          <span className="stat-label">Skills</span>
          <span className="stat-value">{skillsCount}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Experience</span>
          <span className="stat-value">{experienceCount}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Education</span>
          <span className="stat-value">{educationCount}</span>
        </div>
        <div className="stat-chip">
          <span className="stat-label">Availability</span>
          <span className="stat-value stat-value-text">{profile.availability || "N/A"}</span>
        </div>
      </div>

      <div className="profile-card contact-info">
        <h2 className="section-title">Contact Information</h2>
        <div className="info-grid">
          <div className="info-item">
            <span className="info-label">Email</span>
            <span className="info-value">{candidate.email}</span>
          </div>
          
          <div className="info-item">
            <span className="info-label">Phone</span>
            <span className="info-value">{candidate.profile?.phone || "Not provided"}</span>
          </div>
          
          <div className="info-item">
            <span className="info-label">Location</span>
            <span className="info-value">{candidate.profile?.location || "Not provided"}</span>
          </div>
          
          <div className="info-item">
            <span className="info-label">Availability</span>
            <span className="info-value">{candidate.profile?.availability || "Not specified"}</span>
          </div>
        </div>
      </div>

      <div className="profile-card">
        <h2 className="section-title">Skills & Expertise</h2>
        <div className="skills-container">
          {profile.skills?.length > 0 ? (
            profile.skills.map((skill, index) => (
              <span key={index} className="skill-tag">{skill}</span>
            ))
          ) : (
            <p className="no-data">No skills listed</p>
          )}
        </div>

        <h3 className="sub-section-title">Languages</h3>
        <div className="skills-container">
          {profile.languages?.length > 0 ? (
            profile.languages.map((language, index) => (
              <span key={index} className="language-tag">{language}</span>
            ))
          ) : (
            <p className="no-data">No languages listed</p>
          )}
        </div>
      </div>

      <div className="profile-card">
        <h2 className="section-title">Professional Experience</h2>
        {profile.experience?.length > 0 ? (
          <div className="experience-timeline">
            {profile.experience.map((exp, index) => (
              <div key={index} className="experience-item">
                <div className="experience-header">
                  <h3>{exp.title}</h3>
                  <span className="company-name">{exp.company}</span>
                  <span className="duration">{exp.duration}</span>
                </div>
                <p className="experience-description">{exp.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="no-data">No experience listed</p>
        )}
      </div>

      {profile.education && (
        <div className="profile-card">
          <h2 className="section-title">Education</h2>
          {profile.education.length > 0 ? (
            <div className="education-container">
              {profile.education.map((edu, index) => (
                <div key={index} className="education-item">
                  <h3>{edu.degree}</h3>
                  <span className="institution">{edu.institution}</span>
                  <span className="duration">{edu.duration}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-data">No education listed</p>
          )}
        </div>
      )}
      </div>
    </PublicLayout>
  );
};

export default CandidateProfile;