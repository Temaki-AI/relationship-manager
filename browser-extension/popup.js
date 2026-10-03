import { DEFAULT_API_BASE_URL, normalizeApiBaseUrl } from './settings.js';

const elements = {
  apiBaseUrl: document.querySelector('#apiBaseUrl'),
  apiToken: document.querySelector('#apiToken'),
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
  const localSettings = await chrome.storage.local.get({ apiToken: '' });
  let apiBaseUrl = localSettings.apiBaseUrl;
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()) {
    try {
      const legacySettings = await chrome.storage.sync.get({ apiBaseUrl: DEFAULT_API_BASE_URL });
      apiBaseUrl = legacySettings.apiBaseUrl;
    } catch {
      apiBaseUrl = DEFAULT_API_BASE_URL;
    }
    await chrome.storage.local.set({ apiBaseUrl });
  }
  try {
    await chrome.storage.sync.remove('apiBaseUrl');
  } catch {
    // Local settings still work when Chrome Sync is unavailable or disabled.
  }
  const apiToken = localSettings.apiToken;

  elements.apiBaseUrl.value = apiBaseUrl;
  elements.apiToken.value = apiToken;
  elements.extensionId.textContent = chrome.runtime.id;

  elements.saveSettings.addEventListener('click', saveSettings);
  elements.refreshProfile.addEventListener('click', loadProfile);
  elements.importProfile.addEventListener('click', importProfile);

  await loadProfile();
}

async function saveSettings() {
  try {
    const apiBaseUrl = normalizeApiBaseUrl(elements.apiBaseUrl.value);
    const apiToken = elements.apiToken.value.trim();
    await ensureApiAccess(apiBaseUrl);
    elements.apiBaseUrl.value = apiBaseUrl;
    await chrome.storage.local.set({ apiBaseUrl, apiToken });
    setStatus('CRM settings saved.', 'success');
  } catch (error) {
    setStatus(error.message || 'Could not save CRM settings.', 'error');
  }
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
  const apiToken = elements.apiToken.value.trim();
  elements.apiBaseUrl.value = apiBaseUrl;
  elements.importProfile.disabled = true;
  setStatus('Importing contact into Bonds...', 'info');

  try {
    await ensureApiAccess(apiBaseUrl);
    const response = await fetch(`${apiBaseUrl}/api/import/linkedin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
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

    if (response.status === 401) {
      setStatus('CRM authentication failed. Save the correct API token and try again.', 'error');
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

async function ensureApiAccess(apiBaseUrl) {
  const originPattern = `${new URL(apiBaseUrl).origin}/*`;
  const hasAccess = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasAccess) return;

  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error('Chrome needs permission to connect to this CRM URL.');
  }
}
