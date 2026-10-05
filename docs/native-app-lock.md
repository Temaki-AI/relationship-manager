# Native device lock — build-6 source candidate

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

Build 5 remains the separate signed package with its recorded source/checksum.
Build 6 is a new source candidate and requires its own native compile, isolated
startup and device checks. No build-6 package is signed or installed yet. The phone
remains unreachable, and the browser reported the Mac locked. Unlock both devices
and reconnect directly by USB before delivery.

The adapter follows [Expo 57 LocalAuthentication](https://docs.expo.dev/versions/v57.0.0/sdk/local-authentication/)
and [SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/). Both modules
and the Face ID usage description were already in the native configuration; no new
dependency or cloud migration is introduced.
