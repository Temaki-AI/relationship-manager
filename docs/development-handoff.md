# Development handoff — 5 October 2026

The owner resumed work to obtain a working version. The [personal web release](personal-web-release.md) is deployed at everclosecrm.com with real Google sign-in and the existing database preserved. The [personal iOS release](personal-ios-release.md) is installed on TIE Fighter and has downloaded the existing 12-contact workspace after real sign-in. Native database integrity, original relationship fields and shared identities are verified; TestFlight and the full integrated beta remain unfinished.

## Implemented locally

- Core CRM synchronization between web and the native app, with account isolation, offline changes, conflict review, recovery and contact identity preservation.
- Google Contacts connection, reviewed imports and optional recurring reads; iPhone Contacts capture and reviewed linking; LinkedIn profile URLs and reviewed export imports.
- Google Calendar selection, reviewed event context, optional recurring reads, linking to people/plans and reviewed publishing with a separate permission grant.
- Native iOS screens and offline storage; Apple Calendar editor actions, saved operation receipts, explicit verification and optional plan-date following.

LinkedIn support uses URLs and export files. It does not continuously synchronize a LinkedIn account. Apple event receipts and read permissions remain on the phone; approved plan-date changes synchronize with the CRM.

## Verification completed

The last complete regression run passed **783/783 root tests**. Root TypeScript,
targeted root lint and native TypeScript/lint checks passed, as did native unit
tests and the final Hermes release bundle. Google Calendar publishing/setup passed
**18 desktop/mobile browser journeys** using fixtures. Disposable Worker/D1 checks
covered publishing and Apple date transport.

The subsequent web release verified real production Google sign-in, readiness,
authenticated page loads and preservation of 33 original data tables. Native simulator
and device release binaries now compile with Xcode 26.4.1, including the custom Apple
module. The signed iPhone build passes signature verification and is installed.
The native app also launches locally with working Keychain storage and a clean
schema-14 SQLite database; its real Google sign-in welcome screen renders.
Hosted iOS build 37253557642 passes device/simulator compilation and simulator
startup. Physical sign-in/first sync now pass cache verification; simulator contact,
note, interaction and plan creation survive cold restart. Focused account/sync/
Calendar/paging regressions and the complete suite now pass. The contact-draft/timeline
update is signed and installed with all 12 original contacts/notes preserved. New
contact/edit forms resume local drafts, preserving original merge/conflict bases;
timeline pages reach older history. Plan, family, relationship and reminder forms
now also retain unfinished drafts. Reminders preserve their selected time, commit
before OS scheduling and serialize alert refresh/cancellation. The latest journal
update is installed and again preserves all 12 original contacts and notes. Hosted
photo downloads and a bounded account-local cache now have an installed update and
a deployed read-only API. Seven photo/recovery tests pass against real D1; fresh
phone snapshots preserve every original table and field. Actual photo rendering
and native photo selection/upload remain unverified/unfinished. Native run
37255968263 compiled both targets but timed out during hosted Simulator startup;
the isolated prewarm/deadline correction awaits its CI run. The new
visual check awaits permission to switch the shared Simulator
from another project. Separate Google data consent, physical editor
journeys and a phone edit/web round trip remain. See the iOS release record.

Closeout removed the unfinished Gmail scope changes and dependency manifest changes, restoring the previous verified provider configuration. Gmail integration remains unimplemented.

## Remaining beyond the working web release

1. Configure development Google OAuth credentials and verify real sign-in. The current development check reports missing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and refuses a demo/anonymous fallback.
2. Complete actual provider-consent journeys. The web release already provisioned the required queues, applied migrations through 44 after rehearsing the real database copy, and deployed the tested Worker. Separate data-connection clients are still unconfigured.
3. Complete a real native phone edit/web round trip and Calendar editor/permission
   checks. Verify offline synchronization, calendar
   identity changes, timezones and accessibility on the physical iPhone. Native
   compilation/installation are available through the iOS workflow and local signer.
4. Resolve Google/EventKit identity coordination and simultaneous publication across web/phone. Current local guards cannot guarantee global duplicate prevention from an offline phone.
5. Implement Gmail context, then complete the personal daily-use pilot and the remaining public release requirements.

The next bounded milestone should be a real authenticated staging journey: sign in, verify existing contacts, make an edit on the installed iPhone app, and confirm it on the web. Finish that milestone before expanding integration scope.

## Reference documents

- [Full product development plan](product-development-plan.md)
- [Implementation history and validation](implementation-roadmap.md)
- [Development setup](development.md)
- [Contact synchronization](contact-sync.md)
- [Google connections](google-connections.md)
- [Google Calendar](google-calendar.md)
- [Apple Calendar](apple-calendar.md)
- [LinkedIn imports](linkedin-import.md)
