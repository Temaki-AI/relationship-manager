# Everclose personal iOS release — 5 October 2026

**Build 4 is the current signed installation on TIE Fighter.** Its installation
receipt and installed-app metadata confirm success. Both native Release builds,
linkage verification, isolated simulator startup, SQLite and Keychain checks pass
in [run 37278926485](https://github.com/Temaki-AI/relationship-manager/actions/runs/37278926485).
The [build-4 release record](personal-ios-build4.md) contains its exact source,
package hash and checks. After the owner unlocked the phone, the physical launch
and process-stability checks passed. Confirmation that People shows the existing
contacts remains pending.

**Build 6 runs in a dedicated local iPhone simulator and is signed for the phone.** Both native Release builds, linkage,
isolated SQLite/Keychain startup and strict signed-package verification pass. It
adds an optional device-wide Face ID/Touch ID/passcode gate. The phone remains
unreachable; direct USB reconnection and Trust confirmation with both devices
unlocked are pending for physical installation. At the owner's request, local
simulator installation, startup and an actual native offline contact/restart
journey now pass, with a separate synthetic QA device. See
[the build-6 release record](personal-ios-build6.md) for exact source, checksum,
validation and outstanding account/physical checks.

**Build 5 remains separately signed and verified.** Both native Release builds,
linkage and isolated simulator SQLite/Keychain startup pass. Installation could
not begin because CoreDevice could not find the iPhone; reconnection and unlock
are pending. See [the build-5 release record](personal-ios-build5.md) for its exact
source, package checksum and validation. It adds default-off reviewed Gmail
metadata storage; the matching Gmail server deployment remains separate work.

## Previous build 3

Build 3 was signed and installed on TIE Fighter. The actual installation receipt
reports success. The matching device and simulator builds, native linkage check,
and isolated simulator first launch with SQLite/Keychain initialization all pass
in [run 37263450401](https://github.com/Temaki-AI/relationship-manager/actions/runs/37263450401).
The first-launch screenshot renders the real Google sign-in welcome screen.

The signed package is `apps/mobile/build/releases/Everclose-1.0.0-ios-build3.ipa`,
SHA-256 `ab6922a9f9756bfc3d3f7314647d6ae1446e1d6677577e8e63dbd21ffff8c90f`.
Native and JavaScript source are `a5b5a8eec2a303f554413f55bbef49802d5263b6`;
the CI merge source is `69dc05c26e5c58f909e61de4e8df051a0bb9502c`, with its
identical source tree verified before signing. API origin is `https://everclosecrm.com`.

The subsequent compatible tool-dependency patches at `7754c68` also pass both
native Release builds and the isolated startup/SQLite/Keychain check in
[run 37267403749](https://github.com/Temaki-AI/relationship-manager/actions/runs/37267403749).
That later CI result does not change the source of the installed build-3 package.

## Replacement build 3

Photo selection, explicit previews/save/removal, offline drafts, durable uploads
and conflict review are implemented. The API is live at everclosecrm.com in Worker
`f300697b-8aa5-46c8-b556-fc00144725d4`. All 796 root tests, native TypeScript/lint,
five native package tests, five system-picker fixtures and 15 complete photo
journeys against D1 pass. Native schema remains 14; no database migration is added.

Run 37260071983 compiled both native binaries, but the fresh simulator could not
start. Focused diagnostic run 37262303397 captured the exact dyld error:
ExpoFileSystem requires `ExpoModulesCore.BaseModule.willDestroy`, absent from its
embedded Core framework. Symbol inspection confirms the same mismatch in both
architectures. Build 2 was removed from distribution and the verified phone app
was restored successfully. Its failed package and diagnostics are kept privately
as ABI-invalid evidence.

The replacement uses Expo's documented `buildFromSource` option for all iOS
modules, so they compile against the installed Core sources. A new linkage gate
rejects incompatible Expo frameworks before artifact upload/signing; it rejects
the actual failed build. Build 3 passed native startup/SQLite/Keychain verification
before installation. The local signing helper now applies the same linkage gate.

## Use the installed app

Open Everclose on the iPhone. Today, People, profiles, relationship history,
notes, interactions, plans and reminders use the existing account and durable
offline storage. After a successful sync, edits queue while offline and resume
when the app reconnects. Held changes are available in Sync review.

If the welcome screen appears, choose **Continue with Google**, use the same
account as everclosecrm.com and approve this phone in the browser. Return to
Everclose, open **Account & sync** and choose **Sync now**. Then open **People**
and check that the existing relationships appear. Physical process launch now
passes; this UI/data confirmation remains outstanding.

To update a person's photo, open their profile and choose **Edit contact photo**.
Choose an image, review the small preview and explicitly save it. Removal also
requires saving. Drafts and queued changes survive reopening; uncertain uploads
retry the same operation and changed cloud photos require explicit review.

The previous verified build contained 12 contacts. Its database was preserved
exactly through the withdrawn build's rollback. A fresh database comparison after
the build-3 and build-4 upgrades is unverified: automatic approval review rejected copying the
personal contact database, and explicit permission for a private local verification
copy is pending. Installation success is separate from data-continuity evidence.

## Remaining release checks

Physical post-upgrade data visibility, photo selection/rendering,
phone-edit/web round trips, Calendar permissions
and editor actions, closed-app reminder delivery and broader accessibility remain
unverified. The owner's Simulator instruction is fulfilled using dedicated local
Everclose devices; other projects' simulators remain untouched. Google Contacts/Calendar provider
clients and vault configuration, Gmail, Sign in with Apple and TestFlight/App Store
work remain part of the complete integration/public-release plan.

Both native CI jobs and the cloud validation job pass. The general validation jobs
still fail; the recorded dependency-audit findings must be resolved before public
release. This is a personal development installation, not a TestFlight or App Store
release, and does not complete the full integrated beta.

Development signing keys stay local. The existing profile covers four registered
devices and expires 25 July 2027. Phone snapshots, signed packages and actual
installation receipts remain private under the ignored mobile build directory.
