# Personal Relationship Manager

A local-first personal CRM to help you maintain meaningful relationships. Track contacts, log interactions, monitor relationship health, and never miss a birthday.

## Features

- 📊 **Relationship Health Dashboard** - Visual health scores based on contact frequency
- 👥 **Contact Management** - Full contact profiles with tags, notes, and gift ideas
- 💬 **Interaction Logging** - Track calls, messages, meetups, and emails
- 🎂 **Birthday Reminders** - Upcoming birthdays at a glance
- ⚠️ **Action Items** - See who you should reach out to
- 🔍 **Search & Filter** - Find contacts by name, tags, or notes
- 📱 **Mobile Responsive** - Works great on phone, tablet, and desktop

## Tech Stack

- **Next.js 15** - React framework with App Router
- **SQLite** (better-sqlite3) - Local database, no cloud required
- **Tailwind CSS** - Utility-first styling
- **TypeScript** - Type safety
- **Lucide React** - Beautiful icons

## Getting Started

### Prerequisites

- Node.js 22+ 
- npm or pnpm

### Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:3100
```

The app will automatically:
- Create the SQLite database (`data/relationships.db`)
- Initialize the schema
- Seed with sample contacts

### Production Build

```bash
npm run build
npm start
```

## Remote Access

### Option 1: Cloudflare Tunnel (Free, Recommended)

```bash
# Install Cloudflare Tunnel
brew install cloudflared

# Login
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create relationships

# Route domain
cloudflared tunnel route dns relationships relationships.yourdomain.com

# Run tunnel (in a separate terminal)
cloudflared tunnel run relationships --url http://localhost:3100
```

Now access from anywhere at `https://relationships.yourdomain.com`

### Option 2: Tailscale

```bash
# Install Tailscale
brew install tailscale

# Start Tailscale
tailscale up

# Access from any device on your Tailscale network
# using your machine's Tailscale IP + :3100
```

### Option 3: ngrok (Temporary Testing)

```bash
ngrok http 3100
```

## Usage

### Adding Contacts

1. Click "Add Contact" button
2. Fill in basic info (name required)
3. Add tags like "friend", "running", "tech"
4. Set contact frequency (how often you want to stay in touch)
5. Add gift ideas for easy reference

### Logging Interactions

1. Go to any contact detail page
2. Click "Log Interaction"
3. Select type (call, message, meetup, email)
4. Add summary and notes
5. Contact's "last contacted" date updates automatically

### Understanding Health Scores

- **Healthy (75-100%)** - Within target contact frequency
- **Needs Attention (50-75%)** - Approaching target frequency
- **Neglected (<50%)** - Past due for contact

Formula: `100 - ((days since last contact / target frequency) * 100)`

## Database Location

Data is stored in: `data/relationships.db`

**Backup:** Simply copy this file to back up all your data.

## Customization

### Changing Port

Edit `package.json`:

```json
"dev": "next dev -p 3200",
"start": "next start -p 3200"
```

### Database Path

Edit `lib/db.ts` to change the database location.

## Privacy

- **100% local** - No cloud sync, no telemetry
- **Your data stays on your machine**
- SQLite database is just a file you control
- No authentication needed (single-user app)

## Development

```bash
# Install dependencies
npm install

# Run dev server with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Type check
npm run lint
```

## Project Structure

```
├── app/
│   ├── page.tsx              # Dashboard
│   ├── contacts/
│   │   ├── page.tsx         # Contact list
│   │   ├── new/page.tsx     # Add contact form
│   │   └── [id]/
│   │       ├── page.tsx     # Contact detail
│   │       └── edit/page.tsx # Edit contact form
│   ├── api/
│   │   ├── contacts/        # CRUD endpoints
│   │   ├── interactions/    # Log interactions
│   │   └── stats/           # Dashboard stats
│   └── layout.tsx           # Root layout
├── components/ui/           # Reusable UI components
├── lib/
│   ├── db.ts               # SQLite client + schema
│   └── utils.ts            # Helper functions
└── data/
    └── relationships.db    # SQLite database
```

## Troubleshooting

### Database Locked Error

If you see "database is locked", close all terminals/processes running the app.

### Port Already in Use

Change the port in `package.json` or kill the process using port 3100:

```bash
lsof -ti:3100 | xargs kill
```

### Missing Dependencies

```bash
rm -rf node_modules package-lock.json
npm install
```

## Contributing

This is a personal project, but feel free to fork and customize for your needs!

## License

MIT

## Author

Built by Legolas (OpenClaw agent) for Miguel Amaral
