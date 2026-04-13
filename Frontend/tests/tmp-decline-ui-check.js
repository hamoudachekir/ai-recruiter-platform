import { chromium } from '@playwright/test';

async function run() {
  const startRes = await fetch('http://localhost:5004/api/scheduling/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate_id: '69cb04ad8c22bc5de2283c88',
      recruiter_id: '69cb03a88c22bc5de2283c6f',
      job_id: '69cbe8ef21147a473d6ba165',
      application_id: 'e2e-ui-decline-test-002',
      interview_type: 'video',
      interview_mode: 'synchronous',
      duration_minutes: 60,
    }),
  });

  if (!startRes.ok) {
    throw new Error(`Start failed: ${startRes.status}`);
  }

  const startData = await startRes.json();
  console.log('startStatus', startData.status, 'scheduleId', startData.interview_schedule_id);
  const link = String(startData.candidate_action_link || '');
  const token = new URL(link).searchParams.get('token');

  if (!token) {
    throw new Error('No token from start response');
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://localhost:5173/candidate/scheduling?token=${token}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(1500);
  const heading = await page.locator('h1').first().textContent();
  console.log('pageHeading', heading);

  const declineButton = page.getByRole('button', { name: 'Cannot attend this day' });
  if ((await declineButton.count()) === 0) {
    const bodyText = await page.locator('body').innerText();
    console.log('bodyPreview', bodyText.slice(0, 800));
    await page.screenshot({ path: 'test-results/tmp-decline-ui-fail.png', fullPage: true });
    throw new Error('Decline button not found on page');
  }
  await declineButton.click();
  await page.locator('#decline-reason').fill('UI test: cannot attend this day.');

  const now = new Date();
  now.setDate(now.getDate() + 1);
  now.setHours(11, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const localDt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  await page.locator('#preferred-start-0').fill(localDt);

  const declineResponsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes('/api/scheduling/public/') &&
      resp.url().endsWith('/decline') &&
      resp.request().method() === 'POST'
  );

  await page.getByRole('button', { name: 'Submit and regenerate plan' }).click();
  const declineResp = await declineResponsePromise;

  if (declineResp.status() !== 200) {
    throw new Error(`Decline request status ${declineResp.status()}`);
  }

  await page
    .getByText('New interview plan generated and email sent with updated options.')
    .waitFor({ timeout: 15000 });

  const slotCount = await page.locator('.slot-item').count();
  console.log(
    JSON.stringify(
      {
        tokenPrefix: token.slice(0, 8),
        declineStatus: declineResp.status(),
        slotCount,
      },
      null,
      2
    )
  );

  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
