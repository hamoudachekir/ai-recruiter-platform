import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import PublicLayout from "../../layouts/PublicLayout";
import { compressProfileImage, createAdjustedProfileImage } from "../../utils/imageCompression";
import "./CandidateProfile.css";

const getFaceProfileMessage = (faceProfile) => {
  if (faceProfile?.enrolled) {
    return {
      status: "ready",
      text: "Profile photo verified for interview identity check",
    };
  }
  if (faceProfile?.reason === "no_face" || faceProfile?.reason === "no_valid_face") {
    return { status: "error", text: "Face could not be detected, please try another image" };
  }
  if (faceProfile?.reason === "multiple_faces") {
    return { status: "error", text: "Please upload a photo with only your face" };
  }
  if (faceProfile?.reason === "low_quality") {
    return { status: "warning", text: "Please upload a clear profile photo" };
  }
  return { status: "warning", text: "Please upload a clear profile photo" };
};

const CandidateProfile = () => {
  const { id } = useParams();
  const currentUserId = localStorage.getItem("userId");
  const isOwnProfile = String(id) === String(currentUserId);
  const isValidMongoId = /^[a-f\d]{24}$/i.test(String(id || ""));
  const [candidate, setCandidate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isValidMongoId) {
      setError("Invalid candidate profile link.");
      setLoading(false);
      return;
    }

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
  }, [id, isValidMongoId]);

  const handleCameraClick = () => {
    if (isOwnProfile) {
      fileInputRef.current?.click();
    }
  };

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const optimizedFile = await compressProfileImage(file);
      setSelectedFile(optimizedFile);
      setImageZoom(1);
      const reader = new FileReader();
      reader.onload = () => {
        setImagePreview(reader.result);
      };
      reader.readAsDataURL(optimizedFile);
    } catch (err) {
      alert(err.message || "Could not prepare this image.");
      e.target.value = "";
    }
  };

  const handleCancelImage = () => {
    setImagePreview(null);
    setSelectedFile(null);
    setImageZoom(1);
  };

  const handleUploadImage = async () => {
    if (!selectedFile) return;

    setIsUploadingImage(true);
    try {
      const adjustedFile = await createAdjustedProfileImage(selectedFile, { zoom: imageZoom });
      const formData = new FormData();
      formData.append("userId", id);
      formData.append("picture", adjustedFile);

      const res = await fetch("http://localhost:3001/Frontend/upload-profile", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errorPayload = await res.json().catch(() => null);
        throw new Error(errorPayload?.error || `Upload failed with status: ${res.status}`);
      }

      const data = await res.json();
      console.log("✅ Upload response:", data);

      const pictureUrl = data.pictureUrl || data.picture;
      if (pictureUrl) {
        setCandidate(prev => ({ ...prev, picture: pictureUrl, faceProfile: data.faceProfile || prev.faceProfile }));
        setImagePreview(null);
        setSelectedFile(null);
        setImageZoom(1);
        if (data.faceProfile?.enrolled) {
          alert("✅ Profile picture updated and identity face enrolled!");
        } else {
          alert("⚠️ Profile picture updated, but face enrollment needs a clearer photo.");
        }
      } else {
        console.error("No picture URL in response:", data);
        alert("❌ Image uploaded but URL not returned. Please refresh the page.");
      }
    } catch (err) {
      console.error("❌ Failed to upload image:", err);
      alert(`❌ ${err.message || "Failed to upload image. Please try again."}`);
    } finally {
      setIsUploadingImage(false);
    }
  };

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
  const faceProfileMessage = getFaceProfileMessage(candidate.faceProfile);
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
        {imagePreview ? (
          <div className="profile-avatar-editor">
            <div className="profile-avatar-wrapper">
              <img
                src={imagePreview}
                alt="Preview"
                className="profile-avatar profile-avatar-image"
                style={{ transform: `scale(${imageZoom})` }}
              />
              <div className="image-actions">
                <button
                  className="btn-action btn-confirm"
                  onClick={handleUploadImage}
                  disabled={isUploadingImage}
                >
                  {isUploadingImage ? "Uploading..." : "✔"}
                </button>
                <button
                  className="btn-action btn-cancel"
                  onClick={handleCancelImage}
                  disabled={isUploadingImage}
                >
                  ✕
                </button>
              </div>
            </div>
            <label className="profile-image-adjust">
              <span>Size</span>
              <input
                type="range"
                min="1"
                max="2.5"
                step="0.05"
                value={imageZoom}
                onChange={(event) => setImageZoom(Number(event.target.value))}
                disabled={isUploadingImage}
              />
            </label>
          </div>
        ) : candidateImage ? (
          <div className="profile-avatar-wrapper">
            <img
              src={candidateImage}
              alt={candidate.name || "Candidate"}
              className="profile-avatar profile-avatar-image"
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = "/images/team-1.jpg";
              }}
            />
            {isOwnProfile && (
              <button
                className="image-overlay"
                onClick={handleCameraClick}
                type="button"
                aria-label="Change profile picture"
              >
                <span className="camera-icon">📷</span>
              </button>
            )}
          </div>
        ) : isOwnProfile ? (
          <div className="profile-avatar-wrapper">
            <div className="profile-avatar">
              {candidate.name?.charAt(0) || "C"}
            </div>
            <button
              className="image-overlay"
              onClick={handleCameraClick}
              type="button"
              aria-label="Add profile picture"
            >
              <span className="camera-icon">📷</span>
            </button>
          </div>
        ) : (
          <div className="profile-avatar">
            {candidate.name?.charAt(0) || "C"}
          </div>
        )}

        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          onChange={handleImageChange}
          style={{ display: "none" }}
        />
        
        <div className="profile-title">
          <h1>{candidate.name || "Candidate"}</h1>
          <p className="headline">{profile.headline || "Professional Profile"}</p>
          <p className="profile-subtitle">Detailed candidate overview for hiring decisions</p>
          {isOwnProfile && (
            <p className={`face-profile-status face-profile-status--${faceProfileMessage.status}`}>
              {faceProfileMessage.text}
            </p>
          )}
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
