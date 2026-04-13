import { test, expect } from '@playwright/test';

const enterpriseId = process.env.E2E_ENTERPRISE_ID || '69cb03a88c22bc5de2283c6f';
const jobTitleHint = process.env.E2E_JOB_TITLE || 'REACCT';
const baseUrl = process.env.E2E_FRONTEND_URL || 'http://localhost:5173';
const backendUrl = process.env.E2E_BACKEND_URL || 'http://localhost:3001';

const clampIntPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const normalizeApplicationsPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.applications)) return payload.applications;
  if (payload && typeof payload === 'object') return [payload];
  return [];
};

const buildPredictionRequestBody = (application, jobDetails) => ({
  candidate_skills: application?.candidateId?.profile?.skills || [],
  job_skills: jobDetails?.skills || [],
  candidate_exp: application?.candidateId?.profile?.experience || 0,
  required_exp: jobDetails?.requiredExperience || 1,
  candidate_education: application?.candidateId?.profile?.education || '',
  required_education: jobDetails?.education || '',
});

const parseDisplayedPercent = (badgeText) => {
  const percentRegex = /(\d+)%/;
  const match = percentRegex.exec(badgeText || '');
  if (!match) return null;
  return Number(match[1]);
};

const findJobWithQuizApplications = async (request, jobs) => {
  for (const job of jobs) {
    const applicationsResponse = await request.get(`${backendUrl}/Frontend/job-applications/${job._id}`);
    if (!applicationsResponse.ok()) continue;

    const applicationsPayload = await applicationsResponse.json();
    const applications = normalizeApplicationsPayload(applicationsPayload);
    const candidatesWithQuiz = applications.filter((app) => Number(app?.quizLength || 0) > 0);

    if (candidatesWithQuiz.length > 0) {
      return { targetJob: job, targetApplications: candidatesWithQuiz };
    }
  }

  return { targetJob: null, targetApplications: [] };
};

const collectExpectedMatchByEmail = async (request, applications, jobDetails) => {
  const expectedByEmail = new Map();
  let predictionServiceUnavailable = false;

  for (const application of applications) {
    const email = String(application?.candidateId?.email || '').trim().toLowerCase();
    if (!email) continue;

    if (predictionServiceUnavailable) {
      expectedByEmail.set(email, null);
      continue;
    }

    const predictionResponse = await request.post(`${backendUrl}/predict-from-skills`, {
      data: buildPredictionRequestBody(application, jobDetails),
    });

    if (!predictionResponse.ok()) {
      throw new Error(`Prediction API failed for ${email} with status ${predictionResponse.status()}`);
    }

    const predictionPayload = await predictionResponse.json();
    const predictionStatus = String(predictionPayload?.status || '').toLowerCase();

    if (predictionStatus && predictionStatus !== 'success') {
      predictionServiceUnavailable = true;
      expectedByEmail.set(email, null);
      continue;
    }

    expectedByEmail.set(email, resolveExpectedMatchPercent(predictionPayload));
  }

  return expectedByEmail;
};

const assertMatchValuesInCards = async (cards, expectedByEmail) => {
  let comparedCount = 0;

  const cardCount = await cards.count();
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    const emailText = ((await card.locator('.candidate-text p').first().textContent()) || '').trim().toLowerCase();

    if (!expectedByEmail.has(emailText)) {
      continue;
    }

    const expectedValue = expectedByEmail.get(emailText);
    const badgeText = ((await card.getByText(/Job Match:\s*(N\/A|\d+%)/i).first().textContent()) || '').trim();

    if (expectedValue === null) {
      expect(badgeText).toMatch(/Job Match:\s*N\/A/i);
    } else {
      const displayedValue = parseDisplayedPercent(badgeText);
      expect(displayedValue).not.toBeNull();
      expect(displayedValue).toBe(expectedValue);
    }

    comparedCount += 1;
  }

  return comparedCount;
};

const resolveExpectedMatchPercent = (predictionPayload = {}) => {
  const fromApi = clampIntPercent(predictionPayload?.match_percent);
  if (fromApi !== null) return fromApi;

  const skillPercent = clampIntPercent(Number(predictionPayload?.matches?.skill_match || 0) * 100) || 0;
  const expPercent = clampIntPercent(Number(predictionPayload?.matches?.exp_match || 0) * 100) || 0;
  const educationPercent = clampIntPercent(Number(predictionPayload?.matches?.education_match || 0) * 100) || 0;

  return clampIntPercent((skillPercent * 0.55) + (expPercent * 0.3) + (educationPercent * 0.15));
};

const setEnterpriseSession = async (page) => {
  await page.addInitScript(([userId]) => {
    globalThis.localStorage.setItem('userId', userId);
    globalThis.localStorage.setItem('role', 'ENTERPRISE');
  }, [enterpriseId]);
};

const openApplicationsInsightsModal = async (page, targetJobTitle) => {
  const targetUrl = `${baseUrl}/entreprise/${enterpriseId}`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('.job-card, .active-jobs-grid, .modern-jobs-grid', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const cardForJob = page.locator('.job-card').filter({ hasText: targetJobTitle || jobTitleHint }).first();
  if (await cardForJob.count()) {
    const btn = cardForJob.getByRole('button', { name: /view applications/i }).first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 15000 });
  } else {
    const btn = page.getByRole('button', { name: /view applications/i }).first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 15000 });
  }

  await expect(page.getByText('Candidates Quiz Insights (All Applicants)', { exact: true })).toBeVisible({ timeout: 60000 });
};

test('RH modal shows job match percentage and breakdown', async ({ page }) => {
  await setEnterpriseSession(page);
  await openApplicationsInsightsModal(page, jobTitleHint);

  const firstCard = page.locator('.application-card').first();
  await expect(firstCard).toBeVisible({ timeout: 60000 });

  await expect(firstCard.getByText(/Job Match:\s*(N\/A|\d+%)/i).first()).toBeVisible({ timeout: 30000 });
  await expect(firstCard.locator('.match-progress-fill').first()).toBeVisible({ timeout: 30000 });

  await expect(firstCard.getByText(/Skills Fit/i).first()).toBeVisible({ timeout: 30000 });
  await expect(firstCard.getByText(/Experience Fit/i).first()).toBeVisible({ timeout: 30000 });
  await expect(firstCard.getByText(/Education Fit/i).first()).toBeVisible({ timeout: 30000 });
});

test('RH modal displays exact match percent returned by API', async ({ page, request }) => {
  test.setTimeout(120000);

  const jobsResponse = await request.get(`${backendUrl}/Frontend/jobs-by-entreprise/${enterpriseId}`);
  expect(jobsResponse.ok()).toBeTruthy();
  const jobs = await jobsResponse.json();
  expect(Array.isArray(jobs)).toBeTruthy();

  const { targetJob, targetApplications } = await findJobWithQuizApplications(request, jobs);

  expect(targetJob).toBeTruthy();
  expect(targetApplications.length).toBeGreaterThan(0);

  const jobDetailsResponse = await request.get(`${backendUrl}/Frontend/job/${targetJob._id}`);
  expect(jobDetailsResponse.ok()).toBeTruthy();
  const jobDetails = await jobDetailsResponse.json();

  const expectedByEmail = await collectExpectedMatchByEmail(request, targetApplications, jobDetails);

  expect(expectedByEmail.size).toBeGreaterThan(0);

  await setEnterpriseSession(page);
  await openApplicationsInsightsModal(page, String(targetJob?.title || jobTitleHint));

  const cards = page.locator('.application-card');
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);

  const comparedCount = await assertMatchValuesInCards(cards, expectedByEmail);

  expect(comparedCount).toBe(expectedByEmail.size);
});
