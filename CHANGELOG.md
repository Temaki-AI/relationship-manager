# Changelog

## [v1.1.0] - 2026-03-21 (Quick Wins Release)

### Added
- **Reminders System** - Set follow-up reminders for any contact
  - Create reminders with title, notes, and datetime
  - Dashboard widget shows upcoming reminders
  - Overdue reminders highlighted in red
  - Set reminders directly from contact detail page
- **Contact Groups** - Organize contacts into groups (Family, Work, etc.)
  - Create/edit/delete groups
  - Assign contacts to multiple groups
  - API routes for group management
- **Custom Fields** - User-defined data fields via JSON column
  - Store any additional contact data
  - Flexible schema for future expansion
- **CSV Export** - Download all contacts as CSV
  - One-click export from contacts page
  - Includes all standard fields
  - Timestamped filename
- **Competitive Analysis** - Full market research document added

### Changed
- Dashboard now shows "Upcoming Reminders" widget
- Contact detail page has "Set Reminder" button
- Contacts page has "Export CSV" button

### Database
- New table: `reminders`
- New table: `contact_groups`
- New table: `contact_group_members`
- New column: `contacts.custom_fields` (TEXT/JSON)

### API Routes
- `GET /api/reminders` - Fetch all active reminders
- `POST /api/reminders` - Create reminder
- `PATCH /api/reminders/[id]` - Update or complete reminder
- `DELETE /api/reminders/[id]` - Delete reminder
- `GET /api/groups` - Fetch all groups with member counts
- `POST /api/groups` - Create group
- `GET /api/groups/[id]` - Fetch group with members
- `PATCH /api/groups/[id]` - Update group
- `DELETE /api/groups/[id]` - Delete group
- `POST /api/groups/[id]/members` - Add member to group
- `DELETE /api/groups/[id]/members` - Remove member from group
- `GET /api/export/csv` - Export contacts as CSV

---

## [v1.0.0] - 2026-03-21 (Initial Release)

### Added
- **Core Contact Management**
  - Create, read, update, delete contacts
  - Name, email, phone, birthday, photo URL
  - Tags, notes, gift ideas
  - How we met field
  - Target contact frequency
- **Interaction Logging**
  - Log calls, messages, meetups, emails
  - Date, summary, notes per interaction
  - Automatic last contact date updates
- **Relationship Health Tracking**
  - Visual health bars (green/yellow/red)
  - Percentage score based on contact frequency
  - Days since last contact
- **Dashboard**
  - Total contacts stat
  - Conversations this week
  - Neglected contacts (>30 days)
  - Upcoming birthdays (next 30 days)
  - Action items (people to reach out to)
- **Contact List**
  - Search by name, email, notes
  - Filter by tags
  - Card view with health bars
  - Tag badges
- **Contact Detail Page**
  - Full contact information
  - Relationship health meter
  - Gift ideas list
  - Notes section
  - Interaction timeline with icons
  - Log new interactions inline
- **Mobile Responsive**
  - Works on phone, tablet, desktop
  - Adaptive grid layouts
- **Local-First Architecture**
  - SQLite database (no cloud required)
  - All data in `data/relationships.db`
  - Zero telemetry, zero cloud sync

### Tech Stack
- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS
- SQLite (better-sqlite3)
- Lucide React icons

### Deployment
- Local development: `npm run dev`
- Production build: `npm run build && npm start`
- Remote access: Cloudflare Tunnel (see README)
