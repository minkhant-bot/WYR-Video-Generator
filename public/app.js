const button = document.querySelector('#generate'); const statusBox = document.querySelector('#status'); const stage = document.querySelector('#stage'); const percent = document.querySelector('#percent'); const progress = document.querySelector('#progress'); const errorBox = document.querySelector('#error'); const result = document.querySelector('#result');
const labels = { queued: 'Queued', generating_content: 'Generating content with Groq', searching_images: 'Searching Pexels', downloading_assets: 'Downloading photos', generating_voice: 'Generating English voiceover', building_timeline: 'Building timeline and SFX', building_video: 'Building composition', rendering: 'Rendering video', verifying: 'Verifying MP4', completed: 'Completed', failed: 'Failed' };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const settingsForm = document.querySelector('#settings-form'); const saveSettingsButton = document.querySelector('#save-settings'); const settingsMessage = document.querySelector('#settings-message'); const groqKeyStatus = document.querySelector('#groq-key-status'); const pexelsKeyStatus = document.querySelector('#pexels-key-status');

const renderKeyStatus = status => {
  groqKeyStatus.textContent = status.groqConfigured ? 'Configured' : 'Not configured';
  pexelsKeyStatus.textContent = status.pexelsConfigured ? 'Configured' : 'Not configured';
};

const loadKeyStatus = async () => {
  try {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load API key status.');
    renderKeyStatus(await response.json());
  } catch {
    groqKeyStatus.textContent = 'Status unavailable';
    pexelsKeyStatus.textContent = 'Status unavailable';
  }
};

settingsForm.addEventListener('submit', async event => {
  event.preventDefault(); saveSettingsButton.disabled = true; settingsMessage.hidden = true;
  const groqInput = document.querySelector('#groq-api-key'); const pexelsInput = document.querySelector('#pexels-api-key');
  try {
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groqApiKey: groqInput.value, pexelsApiKey: pexelsInput.value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not save API key settings.');
    groqInput.value = ''; pexelsInput.value = ''; renderKeyStatus(body);
    settingsMessage.textContent = 'API keys saved.'; settingsMessage.classList.remove('error'); settingsMessage.hidden = false;
  } catch (error) {
    settingsMessage.textContent = error.message; settingsMessage.classList.add('error'); settingsMessage.hidden = false;
  } finally { saveSettingsButton.disabled = false; }
});

button.addEventListener('click', async () => { button.disabled = true; errorBox.hidden = true; result.hidden = true; statusBox.hidden = false; try { const created = await fetch('/api/jobs', { method: 'POST' }); if (!created.ok) throw new Error(`Could not create job (HTTP ${created.status}).`); let job = await created.json(); while (!['completed', 'failed'].includes(job.status)) { renderStatus(job); await wait(1500); const response = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' }); if (!response.ok) throw new Error(`Could not read job status (HTTP ${response.status}).`); job = await response.json(); } renderStatus(job); if (job.status === 'failed') throw new Error(job.error || 'Generation failed.'); if (!job.outputUrl || !job.downloadUrl) throw new Error('Completed job did not provide verified media URLs.'); document.querySelector('#topic').textContent = job.topic; document.querySelector('#details').textContent = `${job.verification.width}×${job.verification.height} · ${job.verification.duration.toFixed(1)} seconds · H.264 + AAC`; document.querySelector('#video').src = job.outputUrl; document.querySelector('#download').href = job.downloadUrl; document.querySelector('#credits').href = job.creditsUrl; result.hidden = false; } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; } finally { button.disabled = false; } });
function renderStatus(job) { stage.textContent = labels[job.stage] || job.stage; percent.textContent = `${job.progress}%`; progress.value = job.progress; }

void loadKeyStatus();
