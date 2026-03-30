import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar/Navbar';
import Footer from '../components/Footer/Footer';

const LinkedInOAuthCallback = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('Processing LinkedIn connection...');

  useEffect(() => {
    const resolveCandidateId = () => {
      const rawUserId = localStorage.getItem('userId');
      if (rawUserId && rawUserId !== 'null' && rawUserId !== 'undefined') {
        return rawUserId;
      }

      const rawUser = localStorage.getItem('user');
      if (rawUser) {
        try {
          const parsedUser = JSON.parse(rawUser);
          const derivedId = parsedUser?._id || parsedUser?.id;
          if (derivedId && derivedId !== 'null' && derivedId !== 'undefined') {
            return derivedId;
          }
        } catch {
          return null;
        }
      }

      return null;
    };

    const processOAuthCallback = async () => {
      try {
        const currentUserId = resolveCandidateId();
        const profileRedirect = currentUserId ? `/profile/${currentUserId}` : '/login';
        const success = searchParams.get('success');
        const oauthError = searchParams.get('error');
        const oauthDetails = searchParams.get('details');
        const firstName = searchParams.get('firstName');
        const lastName = searchParams.get('lastName');
        const headline = searchParams.get('headline');
        const profilePictureUrl = searchParams.get('profilePictureUrl');
        const memberId = searchParams.get('memberId');
        const grantedScope = searchParams.get('scope');
        const token = searchParams.get('token');

        if (success === 'false' || oauthError) {
          setMessage(`❌ LinkedIn OAuth failed: ${oauthDetails || oauthError || 'Unknown error'}`);
          setLoading(false);
          setTimeout(() => navigate(profileRedirect), 3500);
          return;
        }

        if (!success || !token) {
          setMessage('❌ OAuth failed. Missing token or callback data.');
          setLoading(false);
          setTimeout(() => navigate(profileRedirect), 3000);
          return;
        }

        const userId = resolveCandidateId();
        if (!userId) {
          setMessage('❌ User session invalid. Please login again.');
          setLoading(false);
          setTimeout(() => navigate('/login'), 3000);
          return;
        }

        // Save LinkedIn profile data to user's profile
        const response = await fetch(`http://localhost:3001/api/linkedin/connect-profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({
            candidateId: userId,
            linkedinToken: token,
            firstName,
            lastName,
            headline,
            profilePictureUrl,
            memberId,
            grantedScope
          })
        });

        const data = await response.json();

        if (response.ok) {
          await fetch(`http://localhost:3001/api/linkedin/sync-activity`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ candidateId: userId })
          }).catch(() => null);

          setMessage('✅ LinkedIn connected successfully!');
          setTimeout(() => navigate(`/profile/${userId}`), 2000);
        } else {
          setMessage(`❌ ${data.error || 'Failed to connect LinkedIn'}`);
          setTimeout(() => navigate(`/profile/${userId}`), 3000);
        }
      } catch (error) {
        console.error('OAuth callback error:', error);
        setMessage(`❌ Error: ${error.message}`);
        setLoading(false);
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    processOAuthCallback();
  }, [searchParams, navigate]);

  return (
    <>
      <Navbar />
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '60vh',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {loading && (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '40px',
              height: '40px',
              border: '4px solid #f3f3f3',
              borderTop: '4px solid #0077b5',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 20px'
            }} />
            <p style={{ fontSize: '16px', color: '#666' }}>{message}</p>
          </div>
        )}
        {!loading && (
          <p style={{ fontSize: '16px', color: message.includes('✅') ? 'green' : 'red' }}>
            {message}
          </p>
        )}
      </div>
      <Footer />
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
};

export default LinkedInOAuthCallback;
