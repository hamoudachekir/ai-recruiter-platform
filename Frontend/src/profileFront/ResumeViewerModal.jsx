import { useState } from "react";
import PropTypes from "prop-types";
import { FaTimes, FaDownload } from "react-icons/fa";
import "./ResumeViewerModal.css";

// Opens an uploaded PDF (the raw file, not a generated CvPaper) in-page,
// with a real forced download (fetch → blob → object URL, since the
// `download` attribute is ignored by browsers on cross-origin links).
export default function ResumeViewerModal({ url, title, onClose }) {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = title ? `${title}.pdf` : "cv.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="resume-viewer-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="resume-viewer-shell">
        <div className="resume-viewer-toolbar">
          <span className="resume-viewer-title">{title || "CV"}</span>
          <div className="resume-viewer-actions">
            <button className="rv-btn rv-btn--primary" onClick={handleDownload} disabled={downloading}>
              <FaDownload /> {downloading ? "Téléchargement…" : "Télécharger"}
            </button>
            <button className="rv-btn" onClick={onClose} aria-label="Fermer">
              <FaTimes />
            </button>
          </div>
        </div>
        <iframe className="resume-viewer-frame" src={url} title={title || "CV"} />
      </div>
    </div>
  );
}

ResumeViewerModal.propTypes = {
  url: PropTypes.string.isRequired,
  title: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
