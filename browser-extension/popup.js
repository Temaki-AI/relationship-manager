const DEFAULT_API_BASE_URL = 'http://localhost:3100';

const elements = {
  apiBaseUrl: document.querySelector('#apiBaseUrl'),
  avatar: document.querySelector('#avatar'),
  emptyState: document.querySelector('#emptyState'),
  extensionId: document.querySelector('#extensionId'),
  headline: document.querySelector('#headline'),
  importProfile: document.querySelector('#importProfile'),
  linkedinUrl: document.querySelector('#linkedinUrl'),
  location: document.querySelector('#location'),
  name: document.querySelector('#name'),
  profileCard: document.querySelector('#profileCard'),
  refreshProfile: document.querySelector('#refreshProfile'),
  saveSettings: document.querySelector('#saveSettings'),
  status: document.querySelector('#status'),
};

let currentProfile = null;

init().catch((error) => {
  setStatus(error.message || 'Failed to initialize extension.', 'error');
});

async function init() {
  const { apiBaseUrl = DEFAULT_API_BASE_URL } = await chrome.storage.sync.get({
    apiBaseUrl: DEFAULT_API_BASE_URL,
  });

  elements.apiBaseUrl.value = apiBaseUrl;
  elements.extensionId.textContent = chrome.runtime.id;

  elements.saveSettings.addEventListener('click', saveSettings);
  elements.refreshProfile.addEventListener('click', loadProfile);
  elements.importProfile.addEventListener('click', importProfile);

  await loadProfile();
}

async function saveSettings() {
  const apiBaseUrl = normalizeApiBaseUrl(elements.apiBaseUrl.value);
  elements.apiBaseUrl.value = apiBaseUrl;
  await chrome.storage.sync.set({ apiBaseUrl });
  setStatus('CRM URL saved.', 'success');
}

async function loadProfile() {
  elements.importProfile.disabled = true;
  setStatus('Reading the active LinkedIn profile...', 'info');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://www.linkedin.com/in/')) {
    currentProfile = null;
    renderProfile(null);
    setStatus('Open a LinkedIn profile page under linkedin.com/in/ first.', 'warning');
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_LINKEDIN_PROFILE' });
  if (!response?.ok) {
    currentProfile = null;
    renderProfile(null);
    setStatus(response?.error || 'Could not read this LinkedIn profile.', 'error');
    return;
  }

  currentProfile = response.profile;
  renderProfile(currentProfile);
  elements.importProfile.disabled = false;
  setStatus('Profile ready to import.', 'success');
}

function renderProfile(profile) {
  if (!profile) {
    elements.emptyState.classList.remove('hidden');
    elements.profileCard.classList.add('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  elements.profileCard.classList.remove('hidden');
  elements.name.textContent = profile.fullName || 'Unnamed profile';
  elements.headline.textContent = profile.headline || '';
  elements.location.textContent = profile.location || '';

  if (profile.photoUrl) {
    elements.avatar.src = profile.photoUrl;
    elements.avatar.alt = profile.fullName || 'LinkedIn profile';
    elements.avatar.classList.remove('hidden');
  } else {
    elements.avatar.classList.add('hidden');
  }

  if (profile.linkedinUrl) {
    elements.linkedinUrl.href = profile.linkedinUrl;
    elements.linkedinUrl.textContent = profile.linkedinUrl;
  } else {
    elements.linkedinUrl.removeAttribute('href');
    elements.linkedinUrl.textContent = '';
  }
}

async function importProfile() {
  if (!currentProfile) {
    setStatus('No LinkedIn profile is loaded yet.', 'warning');
    return;
  }

  const apiBaseUrl = normalizeApiBaseUrl(elements.apiBaseUrl.value);
  elements.apiBaseUrl.value = apiBaseUrl;
  elements.importProfile.disabled = true;
  setStatus('Importing contact into Bonds...', 'info');

  try {
    const response = await fetch(`${apiBaseUrl}/api/import/linkedin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentProfile),
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 403) {
      setStatus(
        `CRM blocked this extension origin. Add CORS_ALLOWED_EXTENSION_IDS=${chrome.runtime.id} to .env.local and restart the app.`,
        'error'
      );
      return;
    }

    if (!response.ok) {
      setStatus(data.error || `Import failed (${response.status}).`, 'error');
      return;
    }

    if (data.duplicate) {
      setStatus(`Already in Bonds as "${data.contact?.name || currentProfile.fullName}".`, 'warning');
      return;
    }

    setStatus(`Imported "${data.contact?.name || currentProfile.fullName}" successfully.`, 'success');
  } catch (error) {
    setStatus(error.message || 'Could not reach the Bonds app.', 'error');
  } finally {
    elements.importProfile.disabled = false;
  }
}

function setStatus(message, variant) {
  elements.status.textContent = message;
  elements.status.className = `status status-${variant}`;
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.trim() || DEFAULT_API_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}
