# Competitive Feature Analysis

## Top Personal CRM Tools (2026)

### 1. **Dex** (~$12/mo)
**Positioning:** Professional networker's tool, integration-first

**Key Features We're Missing:**
- ✅ **LinkedIn auto-sync** - Automatically pulls connections, detects job changes
- ✅ **Email integration** - Syncs Gmail/Outlook interactions automatically
- ✅ **Browser extension** - Add notes directly on LinkedIn/Facebook/Gmail
- ✅ **Mobile apps** - iOS + Android native apps
- ✅ **Reminders** - Set follow-up reminders for specific contacts
- ✅ **Job change notifications** - Alert when connections change roles
- ✅ **Activity timeline** - See all interactions across platforms in one view
- ✅ **Custom fields** - User-defined data fields
- ✅ **Smart suggestions** - AI suggests who to reach out to

**Features We Have:**
- Contact CRUD
- Interaction logging
- Relationship health scoring
- Tags
- Gift ideas
- Birthday tracking

---

### 2. **Monica** (Open Source / $9/mo hosted)
**Positioning:** Privacy-focused, personal relationship management

**Key Features We're Missing:**
- ✅ **Debt tracking** - Track money owed/borrowed
- ✅ **Life events** - Log major events (graduation, wedding, job change)
- ✅ **Shared contacts** - Multi-user support (family mode)
- ✅ **Document upload** - Attach files to contacts
- ✅ **Activity types** - Customizable interaction categories
- ✅ **Conversation tracking** - Record full conversation summaries
- ✅ **Call frequency targets** - Set custom cadence per contact
- ✅ **Journal** - Personal diary linked to contacts
- ✅ **API** - REST API for automation

**Features We Have:**
- Contact CRUD
- Interaction logging (calls, messages, meetups, emails)
- Birthday tracking
- Notes
- Gift ideas
- Tags

---

### 3. **Folk** ($20/mo team plan)
**Positioning:** Sales CRM + Personal network, team collaboration

**Key Features We're Missing:**
- ✅ **Email enrichment** - Auto-find email addresses
- ✅ **Phone number lookup** - Auto-find phone numbers
- ✅ **LinkedIn/website scraping** - Import data from prospect sites
- ✅ **Email sequences** - Automated follow-up campaigns
- ✅ **AI message drafts** - Generate personalized outreach
- ✅ **Sales pipelines** - Deal stages and progress tracking
- ✅ **Team collaboration** - Shared contacts, permissions, dashboards
- ✅ **6000+ integrations** - Zapier, email, calendar, social platforms
- ✅ **Chrome extension** - One-click contact capture from LinkedIn

**Features We Have:**
- Contact CRUD
- Interaction logging
- Tags
- Notes

---

## Gap Analysis

### Critical Missing Features (High Impact)

1. **Integrations** 🔴
   - Email sync (Gmail/Outlook) - biggest missing piece
   - Calendar integration
   - LinkedIn connection
   - Mobile apps

2. **Automation** 🟡
   - Reminders (follow-up alerts)
   - Job change notifications
   - Smart suggestions ("You haven't talked to X in 30 days")

3. **Rich Data** 🟡
   - Custom fields
   - Document attachments
   - Life events tracking
   - Debt/money tracking

4. **Collaboration** 🟢 (Low priority for personal CRM)
   - Team sharing
   - Permissions
   - Shared pipelines

### Features We Have That Competitors Don't Emphasize

- **Local-first privacy** - No cloud required (Monica does this too)
- **Relationship health scoring** - Visual health bars (Dex has this, Monica doesn't)
- **Action items dashboard** - Proactive neglected contact alerts
- **Open source potential** - Can be self-hosted

---

## Recommended Priority Roadmap

### Phase 1: Core Gaps (Essential)
1. **Email integration** - Parse Gmail/Outlook for automatic interaction logging
2. **Reminders** - Set follow-up reminders per contact
3. **Custom fields** - Let users add their own data fields
4. **Mobile responsive** - Already done ✅
5. **Document attachments** - Upload files to contacts

### Phase 2: Automation (High Value)
6. **Smart suggestions** - "You should reach out to..." based on frequency
7. **Recurring reminders** - Auto-schedule next contact based on frequency
8. **Email templates** - Quick message drafts for common scenarios
9. **Export/import** - CSV/vCard support

### Phase 3: Power Features (Nice to Have)
10. **LinkedIn integration** - Browser extension or API sync
11. **Mobile apps** - React Native or PWA
12. **Calendar integration** - Sync meeting participants as interactions
13. **Life events timeline** - Major milestones per contact
14. **Debt tracking** - Money owed/borrowed

### Phase 4: Advanced (Long Term)
15. **API** - REST API for automation
16. **Multi-user** - Family/team mode
17. **AI assistants** - Generate message drafts, suggest gift ideas
18. **Voice logging** - "Log a call with Sarah" via voice input

---

## Pricing Comparison

| Tool | Free Tier | Paid |
|------|-----------|------|
| **Dex** | 250 contacts | $12/mo unlimited |
| **Monica** | Self-hosted open source | $9/mo hosted |
| **Folk** | 500 contacts | $20/mo (team-focused) |
| **Clay** | Free | $25/mo |
| **Covve** | 1,000 contacts | $12/mo |
| **Ours** | Unlimited (local) | $0 (no hosting) |

---

## Differentiation Strategy

**What makes us different:**

1. **100% local** - Your data never leaves your machine (vs. Monica's self-hosted requirement)
2. **Zero cost** - No SaaS fees, no hosting bills
3. **Zero learning curve** - Dead simple UI, no sales pipeline complexity
4. **Privacy-first** - No telemetry, no analytics, no cloud sync
5. **Relationship-focused** - Not a sales tool trying to be personal (vs. Folk/Clay)

**Positioning:** "The personal CRM for people who value privacy and simplicity over integrations."

---

## Quick Wins We Can Build Now

1. **Reminders** - Add a reminders table, show in dashboard
2. **Custom fields** - JSON column for user-defined data
3. **Document attachments** - File upload to `data/uploads/{contact_id}/`
4. **Export CSV** - Button to download all contacts
5. **Better search** - Full-text search across notes, interactions
6. **Contact groups** - Group contacts (family, work, running club)
7. **Interaction types customization** - Let users add their own types beyond call/message/meetup/email

---

**Bottom line:** We have 60% of Monica's features and 40% of Dex's. The biggest missing pieces are email integration, reminders, and custom fields. Everything else is polish.
