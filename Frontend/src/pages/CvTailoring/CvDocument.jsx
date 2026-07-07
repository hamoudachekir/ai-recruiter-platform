import { useRef } from 'react';
import PropTypes from 'prop-types';
import CvPaper from './CvPaper';
import { printHtml } from './printCv';
import './cvTailoring.css';

// Full-screen overlay around the paper resume, with reliable print-to-PDF
// (isolated iframe — see printCv.js).

export default function CvDocument({ cv, tailored, template, onClose }) {
  const ref = useRef(null);
  const title = `CV — ${cv?.name || 'candidat'}`;
  return (
    <div className="cv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cv-shell">
        <div className="cv-toolbar">
          <button
            className="cv-btn cv-btn--primary"
            onClick={() => printHtml(ref.current?.innerHTML, title)}
          >Imprimer / PDF</button>
          <button className="cv-btn" onClick={onClose}>Fermer</button>
        </div>
        <div ref={ref}>
          <CvPaper cv={cv} tailored={tailored} template={template} />
        </div>
      </div>
    </div>
  );
}

CvDocument.propTypes = {
  cv: PropTypes.object,
  tailored: PropTypes.object,
  template: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
