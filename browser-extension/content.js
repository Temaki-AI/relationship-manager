chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_LINKEDIN_PROFILE') {
    return undefined;
  }

  try {
    sendResponse({ ok: true, profile: scrapeLinkedInProfile() });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown LinkedIn scraping error.',
    });
  }

  return false;
});

function scrapeLinkedInProfile() {
  if (!window.location.pathname.startsWith('/in/')) {
    throw new Error('This page is not a LinkedIn profile.');
  }

  const fullName = pickFirstNonEmpty([
    () => pickText([
      'h1',
      'main h1',
      '[data-generated-suggestion-target] h1',
      '.pv-text-details__left-panel h1',
      '.ph5 h1',
      'section h1',
      'h1.text-heading-xlarge',
      'h1.inline.t-24',
    ]),
    () => extractNameFromStructuredData(),
    () => cleanNameFromTitle(getMetaContent('meta[property="og:title"]')),
    () => cleanNameFromTitle(document.title),
  ]);

  if (!fullName) {
    throw new Error('Could not find the profile name on this page. Try refreshing the LinkedIn tab once and then click Refresh again.');
  }

  const headline = pickFirstNonEmpty([
    () => pickText([
      '.text-body-medium.break-words',
      '.pv-text-details__left-panel .text-body-medium',
      '[data-generated-suggestion-target] .text-body-medium',
      '.ph5 .text-body-medium',
      'main .text-body-medium',
    ]),
    () => extractHeadlineFromStructuredData(),
    () => extractHeadlineFromMetaDescription(),
    () => cleanHeadlineFromTitle(document.title),
  ]);

  const location = pickFirstNonEmpty([
    () => pickText([
      '.pv-text-details__left-panel .text-body-small.inline',
      '.pv-text-details__left-panel span.text-body-small',
      '[data-generated-suggestion-target] .text-body-small',
      '.ph5 .text-body-small',
      'main .text-body-small.inline',
    ]),
    () => extractLocationFromMetaDescription(),
  ]);

  const canonical =
    document.querySelector('link[rel="canonical"]')?.href ||
    getMetaContent('meta[property="og:url"]') ||
    window.location.href;

  const photoUrl = findBestProfileImage(fullName);

  const company = pickFirstNonEmpty([
    () => extractCompanyFromHeadline(headline),
    () => extractCompanyFromStructuredData(),
  ]);

  return {
    fullName: fullName,
    headline: headline,
    company: company,
    location: location,
    linkedinUrl: canonical,
    photoUrl: photoUrl,
    tags: ['linkedin'],
  };
}

function pickText(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function getMetaContent(selector) {
  return document.querySelector(selector)?.getAttribute('content')?.trim() || null;
}

function getImageSrc(selector) {
  const image = document.querySelector(selector);
  if (!(image instanceof HTMLImageElement)) return null;
  return image.currentSrc || image.src || null;
}

function pickFirstNonEmpty(getters) {
  for (const getter of getters) {
    const value = getter();
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractStructuredData() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed['@graph'])
        ? parsed['@graph']
        : [parsed];

      for (const node of nodes) {
        if (node && typeof node === 'object') {
          const type = node['@type'];
          if (type === 'Person' || (Array.isArray(type) && type.includes('Person'))) {
            return node;
          }
        }
      }
    } catch {
      // Ignore invalid structured data blocks and keep searching.
    }
  }

  return null;
}

function extractNameFromStructuredData() {
  const person = extractStructuredData();
  const name = person?.name;
  return typeof name === 'string' ? name.trim() : null;
}

function extractHeadlineFromStructuredData() {
  const person = extractStructuredData();
  const headline = person?.jobTitle || person?.description;
  return typeof headline === 'string' ? headline.trim() : null;
}

function extractCompanyFromStructuredData() {
  const person = extractStructuredData();
  const worksFor = person?.worksFor;

  if (typeof worksFor?.name === 'string') {
    return worksFor.name.trim();
  }

  if (Array.isArray(worksFor)) {
    for (const entry of worksFor) {
      if (typeof entry?.name === 'string' && entry.name.trim()) {
        return entry.name.trim();
      }
    }
  }

  return null;
}

function cleanNameFromTitle(value) {
  if (!value) return null;

  return value
    .replace(/\s*\|\s*LinkedIn.*$/i, '')
    .replace(/\s*-\s*LinkedIn.*$/i, '')
    .split(/\s+-\s+/)[0]
    .trim() || null;
}

function cleanHeadlineFromTitle(value) {
  if (!value) return null;

  const withoutLinkedIn = value
    .replace(/\s*\|\s*LinkedIn.*$/i, '')
    .replace(/\s*-\s*LinkedIn.*$/i, '')
    .trim();

  const parts = withoutLinkedIn.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(1).join(' - ');
  }

  return null;
}

function extractHeadlineFromMetaDescription() {
  const description = getMetaContent('meta[name="description"]');
  if (!description) return null;

  const parts = description.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts[1] || null;
  }

  return null;
}

function extractLocationFromMetaDescription() {
  const description = getMetaContent('meta[name="description"]');
  if (!description) return null;

  const parts = description.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    return parts[2] || null;
  }

  return null;
}

function extractCompanyFromHeadline(headline) {
  if (!headline) return null;

  const atMatch = headline.match(/\bat\s+(.+)$/i);
  if (atMatch?.[1]) {
    return atMatch[1].trim();
  }

  return null;
}

function findBestProfileImage(fullName) {
  const candidates = [
    getImageSrc('img.pv-top-card-profile-picture__image'),
    getImageSrc('img[data-anonymize="headshot-photo"]'),
    getImageSrc('img.profile-photo-edit__preview'),
    getImageSrc('img.evi-image'),
    getSquareImageNearName(fullName),
    extractPhotoFromStructuredData(),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);

  return candidates[0] || null;
}

function getSquareImageNearName(fullName) {
  const images = Array.from(document.querySelectorAll('img'));

  for (const image of images) {
    if (!(image instanceof HTMLImageElement)) continue;

    const src = image.currentSrc || image.src;
    if (!src) continue;

    const alt = image.alt?.trim().toLowerCase() || '';
    const fullNameLower = fullName.toLowerCase();
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    const ratio = width > 0 && height > 0 ? width / height : null;

    const likelyHeadshot =
      alt === fullNameLower ||
      alt.includes(fullNameLower) ||
      image.dataset.anonymize === 'headshot-photo';

    const squareEnough = ratio !== null ? ratio > 0.8 && ratio < 1.25 : true;
    const largeEnough = width === 0 || height === 0 ? true : width >= 80 && height >= 80;

    if (likelyHeadshot && squareEnough && largeEnough) {
      return src;
    }
  }

  return null;
}

function extractPhotoFromStructuredData() {
  const person = extractStructuredData();
  const image = person?.image;

  if (typeof image === 'string') {
    return image.trim();
  }

  if (Array.isArray(image)) {
    for (const entry of image) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry.trim();
      }
      if (entry && typeof entry === 'object' && typeof entry.url === 'string' && entry.url.trim()) {
        return entry.url.trim();
      }
    }
  }

  if (image && typeof image === 'object' && typeof image.url === 'string') {
    return image.url.trim();
  }

  return null;
}
