# Native device lock — signed build 6

Account & sync now offers an optional device-wide lock for the journal. It starts
off and requires a fresh system authentication before enabling or disabling.
Face ID, Touch ID or the configured device passcode can supply that authentication.
The policy covers all accounts and local-only data on this phone. It stores only
an enabled/disabled marker in this app's device-only Keychain entry; credentials,
SQLite schemas, frozen CRM requests and queued edits are unchanged.

Startup checks the saved policy before mounting account credentials, the database
or journal screens. Once opened, those providers and drafts stay mounted behind
a concealed, noninteractive and accessibility-hidden layer while locked. A
full-screen native Modal gates foreground access, including navigation editors.
An existing lock modal remains under its own system authentication prompt rather
than disappearing during the prompt's inactive transition.

Ordinary inactive transitions lock the journal. Backgrounding or Lock now invalidates
pending authentication, including a success that arrives after returning active.
Duplicate taps do not start a second prompt. An authentication prompt's own inactive
transition hides the screen without invalidating a genuine proof, and private content
does not become visible until active. No lock action changes relationship history
or starts provider consent.

A missing policy is off. Malformed or inaccessible storage fails closed and offers
a retry. Explicit device verification can repair that policy to **enabled**, keeping
the original account cache and drafts. Uncertain writes reload the actual saved
policy; an enabled result requires another unlock. Errors omit native/Keychain details.

This is an app-opening gate, not SQLite encryption, screen-capture prevention or
notification-preview protection. Sync can continue in the retained providers; the
lock does not revoke the device or disconnect an account. Native editor masking,
app-switcher snapshot timing, permission dialogs, biometric changes, device-passcode
fallback and VoiceOver require physical-device verification. A JavaScript lifecycle
mask is not evidence of a synchronous OS privacy shield.

Seventeen mobile package checks pass, including twelve real controller scenarios
for restart, cancellation, inactive/background races, duplicate prompts, lost writes,
fresh disable proof and protected recovery. The 157 existing native data/sync
regressions also pass. Mobile types/lint and Hermes export pass. The first validation
found a removed React Native style constant and a Node strip-only constructor syntax;
both were corrected. The React compiler also rejected an effect-based mount latch;
the latch now belongs to the external controller and validation passes.

Build 6 now passes both native Release jobs, linkage and isolated SQLite/Keychain
startup in run 37321546205. Its first-launch screenshot renders the Google welcome
screen. The downloaded source tree/checksum and signed package were verified;
strict signature verification passes. The [build-6 release record](personal-ios-build6.md)
contains the exact source and package hash. Build 6 is installed in dedicated local
simulators at the owner's request; the actual native journey confirms the setting
starts off. It is not physically installed yet: the phone remains unreachable and
macOS's USB inventory did not detect an iPhone. USB reconnection is needed only for
the later physical delivery. Physical authentication,
native-editor masking, snapshot timing and accessibility checks remain pending.

The adapter follows [Expo 57 LocalAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/local-authentication/)
and [SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/). Both modules
and the Face ID usage description were already in the native configuration; no new
dependency or cloud migration is introduced.
