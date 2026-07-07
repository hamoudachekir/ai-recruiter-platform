import { useState } from 'react';
import PropTypes from 'prop-types';
import TailorCvPanel from './TailorCvPanel';

export default function TailorCvButton({ jobId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="tailor-cta-btn" onClick={() => setOpen(true)}>
        Adapter mon CV à cette offre ✨ <span className="premium-badge">Premium</span>
      </button>
      {open && (
        <div className="tailor-modal-overlay" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="tailor-modal">
            <TailorCvPanel jobId={jobId} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

TailorCvButton.propTypes = {
  jobId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
};
