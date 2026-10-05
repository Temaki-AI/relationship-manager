# Everclose personal iOS build 4 — 5 October 2026

Build 4 is signed and installed on TIE Fighter. The installation receipt reports
success, and Apple's installed-app metadata confirms Everclose 1.0.0, build 4.
Both native Release builds and isolated simulator startup pass in
[run 37278926485](https://github.com/Temaki-AI/relationship-manager/actions/runs/37278926485).
The first-launch screenshot shows the Google sign-in welcome screen. Actual SQLite
initialization and the Keychain installation marker pass their checks.

The private signed package is
`apps/mobile/build/releases/Everclose-1.0.0-ios-build4.ipa`, SHA-256
`61a8e60f7481e3a48096b2851bbc3da18c5742926538ebf352f7c93ee403e726`.
Native and JavaScript source are `542af18677f245e721c98280cb0b101af8b9d090`.
The compiled CI merge is `7ace626119367c07fa2e6541416c295b210c7be4`;
its mobile sources, configuration and domain files match the reviewed source.
The artifact checksum, native linkage and signed app verify. Signing keys remain
on this Mac. API origin is `https://everclosecrm.com`; native schema remains 14.

## Startup recovery

Failed database initialization, locked phone identity storage, or account-cache
selection now show an accessible retry screen instead of leaving the splash
visible. Retry opens the same account cache; it does not reset files, credentials,
drafts or queued edits. Failed initialization releases its SQLite handle. Late
account-cache replies cannot expose another account or block its current startup.

Existing Today, People, profiles, notes, interactions, plans, reminders, contact
photos, reviewed iPhone Contacts capture and Calendar features remain available.
The first account download connects to the hosted workspace. Offline changes and
drafts remain durable, with explicit review for overlapping cloud changes.

## Verification

All 820 root tests pass. The complete D1 suite passes 354 tests; nine large-count
and two trigger-fault cases are intentionally covered by the SQLite suite. These results are recorded in
[run 37277233504](https://github.com/Temaki-AI/relationship-manager/actions/runs/37277233504).
General CI then fails at the unchanged dependency-audit gate. Cloud validation
passes; public distribution still requires resolving the documented findings.

All 152 native behavior tests, five native package tests, native TypeScript/lint
and the production iOS/Hermes export pass. Six focused startup tests cover retry,
account-switch races, locked identity storage, newer schemas, ownership failures
and preservation of saved contacts/outbox entries. Root TypeScript and changed-test
lint pass. The production service is healthy; unauthenticated version-4 phone sync
returns 401. No cloud deployment or production migration was made for this release.

The initial simulator job timed out in Apple's `simctl create` after 60 seconds,
before compilation or app launch. Preparation now allows 180 seconds for that
cold start inside a five-minute setup step. Its fresh retry passes. All simulator
checks use isolated GitHub runners; the shared local Simulator is untouched.

## Phone launch verification

After the owner unlocked TIE Fighter, build 4 launched successfully as process
8278. A separate process check confirmed that it remained running. The private
receipts are `phone-verification/build4-unlocked-launch.json` and
`phone-verification/build4-unlocked-stability.json` in the ignored release directory.
These checks read no screen or contact database. The owner confirmation that
People shows the existing contacts remains pending.

A fresh launch check on 5 October at 08:47 UTC was also refused by Apple's
device tools because the phone was locked, before the successful unlocked check.
Its private receipt is
`apps/mobile/build/releases/phone-verification/build4-final-launch.json`.
The signed IPA checksum was rechecked and still matches the value above.
This check did not read or copy the phone database.

Physical account/data, photo selection, Calendar permission/editor journeys,
phone/web round trips, closed-app reminders and broader accessibility remain
unverified. The optional private database copy was rejected by automatic approval
review because it requires explicit authorization; no new copy was taken.
The owner confirmation request remains pending.

This is the personal development release. Complete provider integrations and
TestFlight/App Store distribution remain separate work. Signed packages, actual
receipts, diagnostics and verification JSON are private in the ignored build
directory. Mobile development dependencies have been restored after clearing
reproducible build output to recover disk space.

At installation, the unfinished Gmail metadata-download work was preserved in
Git stash `3473e7443855718e3aaee489d4ce1aa739add78e` and local D1 had migration 45.
That work has since been restored and extended, with local D1 upgraded to 46;
do not apply the stash again to the current checkout. It is not part of this signed
iOS release. Production remains at migration 44.
