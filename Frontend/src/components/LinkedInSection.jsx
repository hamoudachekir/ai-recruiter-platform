/**
 * LinkedIn Profile Section Component
 * Path: Frontend/src/components/LinkedInSection.jsx
 */

import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { FaLinkedinIn } from 'react-icons/fa';
import './LinkedInSection.css';

export function LinkedInSection({ candidateId, linkedinData, onUpdate, onError }) {
  const [message, setMessage] = useState('');
  const [urlInput, setUrlInput] = useState(linkedinData?.url || '');
  const [expandedPosts, setExpandedPosts] = useState({});

  const isValidLinkedInUrl = (url) => {
    if (!url) return false;
    return /^https?:\/\/(www\.)?linkedin\.com\/(in|company)\/.+/i.test(url.trim());
  };

  const handleEnrichFromLinkedInUrl = () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setMessage('❌ You must login first.');
      return;
    }

    const run = async () => {
      try {
        const normalizedUrl = urlInput?.trim();
        if (!normalizedUrl || !isValidLinkedInUrl(normalizedUrl)) {
          const errorMsg = 'Invalid LinkedIn URL format.';
          setMessage(`❌ ${errorMsg}`);
          onError?.(errorMsg);
          return;
        }

        const response = await fetch('http://localhost:3001/api/linkedin/enrich', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            userId: candidateId,
            linkedinUrl: normalizedUrl
          })
        });

        const data = await response.json();
        if (!response.ok || !data?.success) {
          throw new Error(data.message || data.error || 'Failed to enrich LinkedIn profile');
        }

        onUpdate?.(data.linkedin);
        setMessage('✅ LinkedIn profile imported from URL successfully.');
      } catch (error) {
        setMessage(`❌ ${error.message}`);
        onError?.(error.message);
      }
    };

    run();
  };

  const togglePostExpansion = (index) => {
    setExpandedPosts((prev) => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const formatPostText = (postText) => {
    if (!postText || typeof postText !== 'string') return '';
    return postText.replaceAll(/\s*•\s*/g, '\n• ').trim();
  };

  const posts = Array.isArray(linkedinData?.recentPosts) ? linkedinData.recentPosts.slice(0, 10) : [];

  return (
    <div className="linkedin-section">
      <div className="section-header">
        <FaLinkedinIn className="linkedin-icon" />
        <h3>LinkedIn Posts</h3>
      </div>

      <div style={{ marginBottom: '12px' }}>
        <input
          type="url"
          placeholder="https://www.linkedin.com/in/username"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          style={{ width: '100%', marginBottom: '8px' }}
        />
        <button
          className="btn btn-primary"
          onClick={handleEnrichFromLinkedInUrl}
        >
          🧠 Import from LinkedIn URL
        </button>
      </div>

      <div className="linkedin-profile-card">
        <div className="linkedin-posts-wrapper">
          <h4 className="linkedin-posts-title">Posts</h4>
          {posts.length > 0 ? (
            <div className="linkedin-posts-list">
              {posts.map((post, idx) => {
                const safePost = typeof post === 'string' ? post : String(post || '');
                const isLongPost = safePost.length > 380;
                const isExpanded = Boolean(expandedPosts[idx]);

                return (
                  <article key={`${idx}-${safePost.slice(0, 20)}`} className="linkedin-post-card">
                    <div className="linkedin-post-card-header">
                      <span className="linkedin-post-number">Post {idx + 1}</span>
                    </div>

                    <p className={`linkedin-post-content ${isExpanded ? 'expanded' : 'collapsed'}`}>
                      {formatPostText(safePost)}
                    </p>

                    {isLongPost && (
                      <button
                        type="button"
                        className="linkedin-post-toggle"
                        onClick={() => togglePostExpansion(idx)}
                      >
                        {isExpanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <small className="linkedin-posts-empty">No posts imported yet. Enter a LinkedIn URL then click “Import from LinkedIn URL”.</small>
          )}
        </div>
      </div>

      {/* Messages */}
      {message && (
        <div className={`message ${message.includes('❌') ? 'error' : 'success'}`}>
          {message}
        </div>
      )}
    </div>
  );
}

export default LinkedInSection;

LinkedInSection.propTypes = {
  candidateId: PropTypes.string,
  linkedinData: PropTypes.shape({
    url: PropTypes.string,
    recentPosts: PropTypes.arrayOf(PropTypes.string),
  }),
  onUpdate: PropTypes.func,
  onError: PropTypes.func,
};

LinkedInSection.defaultProps = {
  candidateId: '',
  linkedinData: null,
  onUpdate: undefined,
  onError: undefined,
};
