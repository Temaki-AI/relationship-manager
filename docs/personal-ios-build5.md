# Everclose personal iOS build 5 — release candidate

Build 5 contains native schema 15 and an optional reviewed Gmail metadata cache.
It retains the existing Today, People, profiles, contact photos, notes, interactions,
plans, reminders, iPhone Contacts and Calendar features. Frozen CRM sync version-4
requests and the existing account caches remain compatible with the hosted service.
The additive schema-14 upgrade preserves contacts, cursors, private drafts and
unconfirmed request bytes in the migration test.

Email metadata storage starts off. Account & sync can enable it or clear and disable
it. Per-person cards use a separate owner/device read-only endpoint; no grant,
mailbox download or provider-management action runs from this transport. Identity,
account, consent, dataset epoch and device-session changes invalidate the cache.
Offline display expires after at most 24 hours. Subjects require the retained web
choice. The cache is bounded to 500 messages, 64 profiles and 4 MiB; email observations
do not mark a person as contacted.

## Validation and delivery

All 868 root tests, 15 focused D1/mobile SQLite transport tests, eight desktop/mobile
profile/Calendar journeys, root/native TypeScript and lint, five native package
tests, production Hermes export and standalone/Cloudflare builds pass.

The native configuration requests version 1.0.0, build 5. Device Release compilation,
native linkage verification and isolated CI simulator SQLite/Keychain startup
are pending. There is no build-5 installation or physical UI/data result yet.
Build 4 remains installed; its successful launch/process checks are recorded in
[the build-4 release record](personal-ios-build4.md).

The default server is https://everclosecrm.com. Production was last verified at
migration 44, and Gmail requires migrations 45–47 plus a matching source deployment.
These changes have not been deployed. Enabling email storage against the existing
server reports that email context is unavailable and does not prevent CRM sync.
Dedicated Google OAuth clients/vault and a controlled real-account pilot remain
required for complete provider integrations. Recurring Gmail reconciliation,
reviewed activity behavior and TestFlight/App Store distribution remain open.

Signing keys stay on this Mac. Signed packages, provisioning material and phone
verification receipts belong in the ignored private release directory.
