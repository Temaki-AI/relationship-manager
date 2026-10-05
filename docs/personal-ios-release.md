# Everclose personal iOS release — 5 October 2026

The last verified personal iPhone build is restored on TIE Fighter. Its 12 contacts,
notes, account binding and sync cursor are preserved. The new photo-picker build 2
was withdrawn after its native startup test found a framework incompatibility.
The original signed package remains available as
`apps/mobile/build/releases/Everclose-1.0.0-ios-photos.ipa`, SHA-256
`561c66beb55b2c14a0eaf43012b7d49ef79b905e97da5899a6850017edf026c9`.

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
the actual failed build. The replacement must pass native startup/SQLite/Keychain
verification before installation. Exact replacement binary hashes and data
continuity will be recorded here after those checks succeed.

## Remaining release checks

Physical photo selection/rendering, phone-edit/web round trips, Calendar permissions
and editor actions, closed-app reminder delivery and broader accessibility remain
unverified. The shared local Simulator is in use by another project and switching
it awaits the existing permission request. Google Contacts/Calendar provider
clients and vault configuration, Gmail, Sign in with Apple and TestFlight/App Store
work remain part of the complete integration/public-release plan.

Development signing keys stay local. The existing profile covers four registered
devices and expires 25 July 2027. Phone snapshots, signed packages and actual
installation receipts remain private under the ignored mobile build directory.
