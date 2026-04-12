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
```

Then restart the app with:

```bash
npm run dev
```

## Test Flow

1. Open a LinkedIn profile page like `https://www.linkedin.com/in/...`
2. Open the extension popup
3. Confirm the CRM URL is `http://localhost:3100`
4. Click **Refresh**
5. Click **Import Contact**

The popup will show a success or duplicate message after import.
