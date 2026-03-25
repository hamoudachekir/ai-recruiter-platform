import { Link } from "react-router-dom";
import "./JobCard.css";

const JobCard = ({ job }) => {
  return (
    <div className="job-card">
      <div className="card-header">
        <h3 className="job-title">{job.title}</h3>
      </div>
      
      <div className="card-content">
        <div className="info-row">
          <span className="info-label">
            <i className="fas fa-building"></i> Entreprise
          </span>
          <span className="info-value">{job.enterpriseName}</span>
        </div>
        
        <div className="info-row">
          <span className="info-label">
            <i className="fas fa-map-marker-alt"></i> Localisation
          </span>
          <span className="info-value">{job.location}</span>
        </div>
        
        <div className="info-row">
          <span className="info-label">
            <i className="fas fa-users"></i> Candidats
          </span>
          <span className="applicants-badge">{job.applicants}</span>
        </div>
      </div>
      
      <div className="card-footer">
        <Link to={`/job/${job._id}`} className="btn-see-more">
          Voir Détails <i className="fas fa-arrow-right"></i>
        </Link>
      </div>
    </div>
  );
};

export default JobCard;
