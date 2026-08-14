const startButton = document.querySelector('#start');
const review = document.querySelector('#review');
const slots = document.querySelector('#slots');
const status = document.querySelector('#status');
const stage = document.querySelector('#stage');
const percent = document.querySelector('#percent');
const bar = document.querySelector('#bar');
const errorBox = document.querySelector('#error');
const generate = document.querySelector('#generate');
const stickyGenerate = document.querySelector('#sticky-generate');
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

const selectedCount = value => value.selection?.selectedCount || 0;

const renderSlot = slot => {
  const section = document.createElement('section');
  section.className = 'review-card';

  const heading = document.createElement('h3');
  heading.textContent = `${slot.key} · ${slot.optionText}`;
  section.append(heading);

  const selected = slot.candidates?.find(candidate => candidate.candidateKey === slot.selectedId);

  if (selected) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.src = selected.previewUrl;
    image.alt = slot.optionText;
    section.append(image);

    const meta = document.createElement('div');
    meta.className = 'review-meta';
    meta.textContent = `${selected.provider} · ${selected.sourceDomain || 'unknown'}`;
    section.append(meta);
  } else {
    const missing = document.createElement('div');
    missing.className = 'missing-image';
    missing.textContent = 'Image unavailable';
    section.append(missing);
  }

  const replace = document.createElement('button');
  replace.type = 'button';
  replace.className = 'replace';
  replace.textContent = selected ? 'Replace' : 'Retry';
  replace.onclick = async () => {
    clearError();
    replace.disabled = true;
    replace.textContent = 'Searching…';
    try {
      renderReview(await request(`/api/jobs/${job.id}/images/${slot.key}/replace`, {
        method: 'POST',
      }));
    } catch (error) {
      showError(error);
      replace.disabled = false;
      replace.textContent = selected ? 'Replace' : 'Retry';
    }
  };
  section.append(replace);

  return section;
};

const renderReview = value => {
  job = value;
  review.hidden = false;
  status.hidden = true;
  const count = selectedCount(value);
  document.querySelector('#topic').textContent = value.topic || 'Review images';
  document.querySelector('#progress-label').textContent = `${count} of 16 images ready`;
  document.querySelector('#sticky-progress').textContent = `${count} of 16 images ready`;
  generate.disabled = count !== 16;
  stickyGenerate.disabled = count !== 16;
  slots.replaceChildren(...Object.values(value.selection?.slots || {}).map(renderSlot));
};

const poll = async () => {
  while (job && !['reviewing_images', 'selecting_images', 'completed', 'failed'].includes(job.status)) {
    await wait(900);
    job = await request(`/api/jobs/${job.id}`);
    renderStatus(job);
  }

  if (job?.status === 'reviewing_images' || job?.status === 'selecting_images') {
    renderReview(job);
    return;
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

const generateVideo = async () => {
  clearError();
  try {
    generate.disabled = true;
    stickyGenerate.disabled = true;
    status.hidden = false;
    review.hidden = true;
    job = await request(`/api/jobs/${job.id}/generate`, { method: 'POST' });
    renderStatus(job);
    await poll();
  } catch (error) {
    showError(error);
    if (job) renderReview(job);
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

generate.onclick = generateVideo;
stickyGenerate.onclick = generateVideo;
