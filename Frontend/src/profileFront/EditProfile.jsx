import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader } from "./card";
import { FaCamera, FaSave } from "react-icons/fa";
import CreatableSelect from "react-select/creatable";
import "./EditProfile.css";
import Navbar from "../components/Navbar/Navbar";
import Footer from "../components/Footer/Footer";

const PROFILE_IMAGE_MAX_SIZE = 15 * 1024 * 1024;

const skillsList = [
  { value: "JavaScript", label: "JavaScript" }, { value: "Python", label: "Python" },
  { value: "React", label: "React" }, { value: "Node.js", label: "Node.js" },
  { value: "Django", label: "Django" }, { value: "SQL", label: "SQL" },
  { value: "MongoDB", label: "MongoDB" }, { value: "HTML", label: "HTML" },
  { value: "CSS", label: "CSS" }, { value: "Java", label: "Java" },
  { value: "C++", label: "C++" }, { value: "Ruby", label: "Ruby" },
  { value: "PHP", label: "PHP" }, { value: "Swift", label: "Swift" },
  { value: "Kotlin", label: "Kotlin" }, { value: "Go", label: "Go" },
  { value: "TypeScript", label: "TypeScript" }, { value: "C#", label: "C#" },
  { value: "Rust", label: "Rust" }, { value: "Shell Scripting", label: "Shell Scripting" }
];

const formatExperienceForTextarea = (rawExperience) => {
  if (typeof rawExperience === "string") {
    return rawExperience;
  }

  if (Array.isArray(rawExperience)) {
    const lines = rawExperience
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }

        if (item && typeof item === "object") {
          const title = String(item.title || "").trim();
          const company = String(item.company || "").trim();
          const duration = String(item.duration || "").trim();
          const description = String(item.description || "").trim();

          const head = [title, company ? `at ${company}` : "", duration ? `(${duration})` : ""]
            .filter(Boolean)
            .join(" ")
            .trim();

          return [head, description]
            .filter(Boolean)
            .join(" - ")
            .trim();
        }

        return "";
      })
      .filter(Boolean);

    return lines.join("\n");
  }

  if (rawExperience && typeof rawExperience === "object") {
    return Object.values(rawExperience)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
  }

  return "";
};

const parseExperienceFromTextarea = (rawValue) => {
  const content = String(rawValue || "");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const [headRaw, ...descriptionParts] = line.split(" - ");
    const head = String(headRaw || "").trim();
    const description = descriptionParts.join(" - ").trim();

    let duration = "";
    let headWithoutDuration = head;
    const durationRegex = /\(([^)]+)\)\s*$/;
    const durationMatch = durationRegex.exec(head);
    if (durationMatch) {
      duration = String(durationMatch[1] || "").trim();
      headWithoutDuration = head.replace(/\(([^)]+)\)\s*$/, "").trim();
    }

    const atIndex = headWithoutDuration.toLowerCase().indexOf(" at ");
    const title = atIndex >= 0 ? headWithoutDuration.slice(0, atIndex).trim() : headWithoutDuration;
    const company = atIndex >= 0 ? headWithoutDuration.slice(atIndex + 4).trim() : "";

    return {
      title,
      company,
      duration,
      description,
    };
  });
};

const EditProfile = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [formData, setFormData] = useState({});
  const [oldPassword, setOldPassword] = useState("");
  const [newPicture, setNewPicture] = useState(null);
  const [selectedPictureFile, setSelectedPictureFile] = useState(null);

  const skillOptions = useMemo(() => {
    const fromProfile = Array.isArray(formData.profile?.skills)
      ? formData.profile.skills.map((skill) => ({ value: skill, label: skill }))
      : [];

    return [...skillsList, ...fromProfile].reduce((acc, option) => {
      if (!option?.value) return acc;
      if (!acc.some((item) => item.value.toLowerCase() === String(option.value).toLowerCase())) {
        acc.push({ value: String(option.value), label: String(option.label || option.value) });
      }
      return acc;
    }, []);
  }, [formData.profile?.skills]);

  const selectedSkillOptions = useMemo(() => {
    const selectedSkills = Array.isArray(formData.profile?.skills) ? formData.profile.skills : [];
    return selectedSkills.map((skill) => ({ value: skill, label: skill }));
  }, [formData.profile?.skills]);

  useEffect(() => {
    fetch(`http://localhost:3001/Frontend/getUser/${id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed to load user: ${res.status}`))))
      .then((data) => {
        setUser(data);
        setFormData({
          name: data.name || "",
          email: data.email || "",
          password: "",
          profile: {
            availability: data.profile?.availability ?? "Full-time",
            skills: data.profile?.skills ?? [],
            languages: data.profile?.languages ?? [],
            experience: formatExperienceForTextarea(data.profile?.experience),
            resume: data.profile?.resume ?? "",
            phone: data.profile?.phone ?? "",
          },
        });
        setLoading(false);
      })
      .catch((error) => {
        console.error("Error loading user:", error);
        setLoading(false);
      });
  }, [id]);

  const handleSave = async () => {
    try {
      const normalizedExperience = parseExperienceFromTextarea(formData.profile?.experience);

      const payload = {
        ...formData,
        profile: {
          ...formData.profile,
          skills: Array.isArray(formData.profile?.skills) ? formData.profile.skills : [],
          experience: normalizedExperience,
        },
      };

      const response = await fetch(`http://localhost:3001/Frontend/updateUser/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

      if (selectedPictureFile) {
        const pictureFormData = new FormData();
        pictureFormData.append("userId", id);
        pictureFormData.append("picture", selectedPictureFile);

        const pictureResponse = await fetch("http://localhost:3001/Frontend/upload-profile", {
          method: "POST",
          body: pictureFormData,
        });

        if (!pictureResponse.ok) {
          const uploadError = await pictureResponse.json().catch(() => null);
          throw new Error(uploadError?.error || `Image upload failed. Status: ${pictureResponse.status}`);
        }

        const pictureData = await pictureResponse.json();
        if (pictureData?.pictureUrl) {
          setUser((prev) => ({ ...prev, picture: pictureData.pictureUrl }));
        }
      }

      const data = await response.json();
      console.log("✅ Profil mis à jour avec succès :", data);
      navigate(`/profile/${id}`);
    } catch (error) {
      console.error("❌ Erreur mise à jour du profil :", error);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (name === "phone") {
      setFormData((prev) => ({
        ...prev,
        profile: { ...prev.profile, phone: value },
      }));
    } else {
      setFormData((prev) => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  const handleSkillSelection = (selectedOptions) => {
    setFormData((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        skills: (selectedOptions || []).map((option) => option.value),
      },
    }));
  };

  const handleCreateSkill = (inputValue) => {
    const newSkill = String(inputValue || "").trim();
    if (!newSkill) return;

    setFormData((prev) => {
      const currentSkills = Array.isArray(prev.profile?.skills) ? prev.profile.skills : [];
      const alreadyExists = currentSkills.some(
        (skill) => String(skill).toLowerCase() === newSkill.toLowerCase()
      );

      if (alreadyExists) return prev;

      return {
        ...prev,
        profile: {
          ...prev.profile,
          skills: [...currentSkills, newSkill],
        },
      };
    });
  };

  const handleCameraClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handlePictureChange = (event) => {
    const selectedFile = event.target.files[0];
    if (!selectedFile) return;

    if (selectedFile.size > PROFILE_IMAGE_MAX_SIZE) {
      window.alert("Image too large. Maximum size is 15MB.");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => setNewPicture(reader.result);
    reader.readAsDataURL(selectedFile);
    setSelectedPictureFile(selectedFile);
  };

  if (loading) return <p className="edit-profile-feedback">Loading profile...</p>;
  if (!user) return <p className="edit-profile-feedback">User not found.</p>;

  const pictureValue = user?.picture ? String(user.picture) : "";
  let normalizedPictureSrc = "/images/team-1.jpg";
  if (pictureValue) {
    normalizedPictureSrc = pictureValue.startsWith("http")
      ? pictureValue
      : `http://localhost:3001${pictureValue}`;
  }
  const profileImageSrc = newPicture || normalizedPictureSrc;


  return (
    <>
      <Navbar />
  
      <div className="profile-container">
        <Card className="card edit-profile-card">
  
          {/* Header avec Avatar et Email */}
          <CardHeader className="card-header">
            <div className="avatar-container">
              <img
                src={profileImageSrc}
                className="avatar"
                alt="Profile"
              />
              <button type="button" className="camera-icon" onClick={handleCameraClick}>
                <FaCamera />
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handlePictureChange}
                accept="image/*"
                style={{ display: "none" }}
              />
            </div>
  
            <h2 className="name">{user.name.toUpperCase()}</h2>
            <p className="email">{user.email}</p>
            <p className="profile-subtitle">Keep your profile current to improve matching accuracy.</p>
          </CardHeader>
  
          {/* Contenu du formulaire */}
          <CardContent className="card-body">
            <section className="profile-section">
              <h2>Informations personnelles</h2>
              <div className="form-grid">
                <div className="form-group">
                  <label htmlFor="edit-name">Nom</label>
                  <input id="edit-name" type="text" name="name" value={formData.name} onChange={handleInputChange} />
                </div>

                <div className="form-group">
                  <label htmlFor="edit-email">Email</label>
                  <input id="edit-email" type="email" name="email" value={formData.email} onChange={handleInputChange} />
                </div>

                <div className="form-group form-group-full">
                  <label htmlFor="edit-phone">Téléphone</label>
                  <input
                    id="edit-phone"
                    type="text"
                    name="phone"
                    value={formData.profile.phone}
                    onChange={handleInputChange}
                  />
                </div>
              </div>
            </section>

            <section className="profile-section">
              <h2>Skills</h2>
              <div className="form-group">
                <CreatableSelect
                  isMulti
                  options={skillOptions}
                  value={selectedSkillOptions}
                  onChange={handleSkillSelection}
                  onCreateOption={handleCreateSkill}
                  placeholder="Select or type to add skills"
                  classNamePrefix="skills-select"
                />
              </div>
            </section>

            <section className="profile-section">
              <h2>Experience</h2>
              <div className="form-group">
                <textarea
                  name="experience"
                  value={formData.profile.experience}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      profile: { ...prev.profile, experience: e.target.value },
                    }))
                  }
                  rows={7}
                  placeholder="Describe your experience, roles, and impact..."
                />
              </div>
            </section>

            <section className="profile-section">
              <h2>Sécurité</h2>
              <div className="form-grid">
                <div className="form-group">
                  <label htmlFor="edit-old-password">Ancien mot de passe</label>
                  <input
                    id="edit-old-password"
                    type="password"
                    name="oldPassword"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="edit-new-password">Nouveau mot de passe</label>
                  <input
                    id="edit-new-password"
                    type="password"
                    name="password"
                    value={formData.password}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        password: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
            </section>

            <div className="save-row">
              <button className="save-button" onClick={handleSave}>
                <FaSave /> Sauvegarder les modifications
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
  
      <Footer />
    </>
  );
  
};

export default EditProfile;
