// Sample React frontend function for LinkedIn enrichment via backend Apify endpoint
export async function enrichLinkedInProfile({ userId, linkedinUrl, token }) {
  const response = await fetch('http://localhost:3001/api/linkedin/enrich', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ userId, linkedinUrl }),
  });

  const data = await response.json();

  if (!response.ok || !data?.success) {
    throw new Error(data?.message || 'LinkedIn enrichment failed');
  }

  return data;
}
