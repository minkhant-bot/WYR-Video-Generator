const startButton = document.querySelector('#start');
const status = document.querySelector('#status');
const stage = document.querySelector('#stage');
const percent = document.querySelector('#percent');
const bar = document.querySelector('#bar');
const errorBox = document.querySelector('#error');
let job = null;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const request = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
};

const showError = error => {
  errorBox.textContent = error.message;
  errorBox.hidden = false;
};

const clearError = () => {
  errorBox.hidden = true;
  errorBox.textContent = '';
};

const renderStatus = value => {
  stage.textContent = value.stage || value.status || 'Working';
  percent.textContent = `${value.progress || 0}%`;
  bar.value = value.progress || 0;
};

const poll = async () => {
  while (job && !['completed', 'failed'].includes(job.status)) {
    await wait(900);
    job = await request(`/api/jobs/${job.id}`);
    renderStatus(job);
  }

  if (job?.status === 'completed') {
    status.hidden = true;
    document.querySelector('#result-topic').textContent = job.topic;
    document.querySelector('#video').src = job.outputUrl;
    document.querySelector('#download').href = job.downloadUrl;
    document.querySelector('#result').hidden = false;
    // The Content Pool panel's ready/used counts change server-side the moment this job commits
    // its questions -- without this, the panel keeps showing whatever it last fetched (e.g. at
    // page load), silently stale until the user happens to hit "Refresh" themselves.
    if (poolTokenInput.value) void refreshPoolStatus();
    return;
  }

  if (job?.status === 'failed') {
    status.hidden = true;
    const label = job.errorCode ? `${job.errorCode}: ${job.error || 'Job failed.'}` : (job.error || 'Job failed.');
    showError(new Error(label));
  }
};

startButton.onclick = async () => {
  clearError();
  try {
    startButton.disabled = true;
    status.hidden = false;
    job = await request('/api/jobs', { method: 'POST' });
    renderStatus(job);
    await poll();
  } catch (error) {
    showError(error);
  } finally {
    // Re-enable on EVERY outcome (network error, job.status === 'failed', or completion) -- a
    // failed job must never leave the user stuck unable to try again.
    startButton.disabled = false;
  }
};

// Mobile-only Content Pool panel: reads/refills the PostgreSQL question pool via the admin
// endpoints. Gated server-side by a Bearer admin token (WYR_ADMIN_TOKEN); the token is kept only
// in this device's localStorage and sent on each admin request, never persisted server-side here.
const poolReadyEl = document.querySelector('#pool-ready');
const poolTotalEl = document.querySelector('#pool-total');
const poolStatusEl = document.querySelector('#pool-refill-status');
const poolTokenInput = document.querySelector('#pool-admin-token');
const poolRefreshButton = document.querySelector('#pool-refresh');
const poolRefillButton = document.querySelector('#pool-refill');
const poolSeedButton = document.querySelector('#pool-seed-static');
const poolErrorBox = document.querySelector('#pool-error');
const ADMIN_TOKEN_KEY = 'wyrAdminToken';

poolTokenInput.value = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
poolTokenInput.onchange = () => localStorage.setItem(ADMIN_TOKEN_KEY, poolTokenInput.value.trim());

const showPoolError = message => { poolErrorBox.textContent = message; poolErrorBox.hidden = false; };
const clearPoolError = () => { poolErrorBox.hidden = true; poolErrorBox.textContent = ''; };

const adminRequest = async (url, options = {}) => {
  const token = poolTokenInput.value.trim();
  const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
};

const renderPoolStats = data => {
  poolReadyEl.textContent = data.ready ?? '–';
  poolTotalEl.textContent = data.total ?? '–';
  poolStatusEl.textContent = data.refillRunning
    ? `Refilling (target ${data.target ?? '?'})…`
    : data.lastRefillStatus
      ? `Last refill: ${data.lastRefillStatus.stoppedReason || data.lastRefillStatus.message || 'done'} (ready ${data.lastRefillStatus.finalReady ?? '?'})`
      : 'No refill run yet.';
};

const refreshPoolStatus = async () => {
  clearPoolError();
  try {
    const data = await adminRequest('/api/admin/content-pool/status');
    renderPoolStats(data);
  } catch (error) {
    showPoolError(error.message);
  }
};

poolRefreshButton.onclick = refreshPoolStatus;

poolRefillButton.onclick = async () => {
  clearPoolError();
  poolRefillButton.disabled = true;
  try {
    const data = await adminRequest('/api/admin/content-pool/refill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 200 }),
    });
    renderPoolStats(data);
  } catch (error) {
    showPoolError(error.message);
  } finally {
    poolRefillButton.disabled = false;
  }
};

poolSeedButton.onclick = async () => {
  clearPoolError();
  poolSeedButton.disabled = true;
  const originalLabel = poolSeedButton.textContent;
  poolSeedButton.textContent = 'Seeding…';
  try {
    const data = await adminRequest('/api/admin/content-pool/seed-static', { method: 'POST' });
    poolReadyEl.textContent = data.ready ?? '–';
    poolTotalEl.textContent = data.total ?? '–';
    poolStatusEl.textContent = `Seed done: +${data.inserted} inserted, ${data.skipped} already seeded, ${data.rejected} rejected.`;
  } catch (error) {
    showPoolError(error.message);
  } finally {
    poolSeedButton.disabled = false;
    poolSeedButton.textContent = originalLabel;
  }
};

const poolImportFileInput = document.querySelector('#pool-import-file');
const poolImportStatusEl = document.querySelector('#pool-import-status');

// Mobile file pickers (Android/iOS) trigger `change` as soon as a file is chosen, so importing
// starts immediately on selection rather than requiring a separate "upload" tap.
poolImportFileInput.onchange = async () => {
  const file = poolImportFileInput.files?.[0];
  if (!file) return;
  clearPoolError();
  poolImportFileInput.disabled = true;
  poolImportStatusEl.textContent = `Importing ${file.name}…`;
  try {
    const text = await file.text();
    const data = await adminRequest('/api/admin/content-pool/import-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    poolTotalEl.textContent = data.total ?? '–';
    poolImportStatusEl.textContent = `Inserted: ${data.inserted} | Skipped duplicates: ${data.skipped} | Rejected: ${data.rejected} | Pool total: ${data.total}`;
    await refreshPoolStatus(); // authoritative ready/total + refill status refresh
  } catch (error) {
    poolImportStatusEl.textContent = '';
    showPoolError(error.message);
  } finally {
    poolImportFileInput.disabled = false;
    poolImportFileInput.value = '';
  }
};

if (poolTokenInput.value) void refreshPoolStatus();
