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
    return;
  }

  if (job?.status === 'failed') {
    showError(new Error(job.error || 'Job failed.'));
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
    startButton.disabled = false;
  }
};
