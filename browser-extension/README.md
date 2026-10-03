# Bonds Chrome Extension

This unpacked Chrome extension imports the active LinkedIn profile into the Bonds CRM.

## Load It In Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `browser-extension/` folder from this repo

The extension uses a fixed manifest key, so its Chrome ID should be:

`ogodllnlbnmkhmaccmnoepajfapennja`

## CRM Setup

Create `.env.local` in the repo root with:

```bash
CORS_ALLOWED_EXTENSION_IDS=ogodllnlbnmkhmaccmnoepajfapennja
CRM_API_TOKEN=replace-with-at-least-32-random-characters
```

`CRM_API_TOKEN` is optional while local development authentication is disabled, but
required when the CRM authentication variables are configured. Keep it separate
from `CRM_PASSWORD`.

The extension stores both the CRM origin and API token in Chrome's device-local
extension storage. Neither value uses Chrome Sync. Remote CRM origins must use HTTPS;
plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]`, and Bonds rejects
URLs containing credentials, paths, queries, or fragments.
When upgrading from version 0.1.0, the popup moves the previously synchronized CRM URL
into local storage once and deletes the legacy Chrome Sync key.

Then restart the app with:

```bash
npm run dev
```

## Test Flow

1. Open a LinkedIn profile page like `https://www.linkedin.com/in/...`
2. Open the extension popup
3. Confirm the CRM URL is `http://localhost:3100`
4. Paste the API token and click **Save settings**
5. Click **Refresh**
6. Click **Import Contact**

The popup will show a success or duplicate message after import.
