# Development handoff — 4 October 2026

The owner resumed work to obtain a working version. The [personal web release](personal-web-release.md) is deployed at everclosecrm.com with real Google sign-in and the existing database preserved. The [personal iOS release](personal-ios-release.md) has been compiled and installed on the paired iPhone TIE Fighter. Native sign-in awaits unlocking that phone; TestFlight and the full integrated beta remain unfinished.

## Implemented locally

- Core CRM synchronization between web and the native app, with account isolation, offline changes, conflict review, recovery and contact identity preservation.
- Google Contacts connection, reviewed imports and optional recurring reads; iPhone Contacts capture and reviewed linking; LinkedIn profile URLs and reviewed export imports.
- Google Calendar selection, reviewed event context, optional recurring reads, linking to people/plans and reviewed publishing with a separate permission grant.
- Native iOS screens and offline storage; Apple Calendar editor actions, saved operation receipts, explicit verification and optional plan-date following.

LinkedIn support uses URLs and export files. It does not continuously synchronize a LinkedIn account. Apple event receipts and read permissions remain on the phone; approved plan-date changes synchronize with the CRM.

## Verification completed

The last complete regression run passed **756/756 root tests**. Root and native TypeScript/lint checks passed, as did native unit tests and the iOS JavaScript export. Google Calendar publishing/setup passed **18 desktop/mobile browser journeys** using fixtures. Disposable Worker/D1 checks covered publishing and Apple date transport.

The subsequent web release verified real production Google sign-in, readiness,
authenticated page loads and preservation of 33 original data tables. Native simulator
and device release binaries now compile with Xcode 26.4.1, including the custom Apple
module. The signed iPhone build passes signature verification and is installed.
The native app also launches locally with working Keychain storage and a clean
schema-14 SQLite database; its real Google sign-in welcome screen renders. The
hosted simulator runtime check timed out in Apple's cold-boot data migration.
Separate Google data-connection consent and physical native sign-in/editor journeys
remain unverified. See the iOS release record for the actual installation evidence.

Closeout removed the unfinished Gmail scope changes and dependency manifest changes, restoring the previous verified provider configuration. Gmail integration remains unimplemented.

## Remaining beyond the working web release

1. Configure development Google OAuth credentials and verify real sign-in. The current development check reports missing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and refuses a demo/anonymous fallback.
2. Complete actual provider-consent journeys. The web release already provisioned the required queues, applied migrations through 44 after rehearsing the real database copy, and deployed the tested Worker. Separate data-connection clients are still unconfigured.
3. Unlock TIE Fighter and complete native Google sign-in, first download and a real
   phone/web edit. Verify permissions, editors, offline synchronization, calendar
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
