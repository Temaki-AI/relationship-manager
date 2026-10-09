# Modern + Warm implementation · 9 October 2026

The approved Modern + Warm concept is implemented across web and iPhone. The [design system](design-system.md) defines shared semantic colors, type, spacing, corner radii, motion, elevation, avatars, actions, form/feedback states, responsive behavior and accessibility rules. Its canonical tokens live in `packages/design/src/tokens.ts`. Web has an authenticated `/design-system` component reference; the approved image and synthetic-only implementation screenshots are preserved in `docs/design/`.

The application uses warm ivory surfaces, rose actions, charcoal sans-serif headings and stable pastel initials. Today adds the compact heart wordmark and primary Reach out action. People uses the shared avatars and scalable field chrome. Profiles, Calendar, Settings, contact/reminder editors, provider review, recovery, and feedback use the same surfaces and semantic colors. Existing data mutations, OAuth, provider consent, draft guards and destructive confirmations retain their behavior. No dependency, native module, Expo config or native asset was changed.

## Verification

- Web build, root types and lint pass. The final responsive audit passes **52 screen renders**: 13 routes at 320, 393, 768 and 1280 px. Each checks horizontal overflow, main-navigation target height and WCAG-tagged Axe rules. This includes the component reference. Six contact-method, navigation and secondary-tool journeys pass on desktop/mobile in the preceding browser run. That run also caught a legacy amber caption on the new warning surface; the final audit passes after switching remaining status foregrounds to semantic tokens. Earlier failure artifacts remain in the ignored build directory.
- All **13** selected design/accessibility/auth contracts and **22** mobile unit cases pass. Native types, lint and production Hermes bundling pass. Shared contracts check web/native token parity, 4.5:1 text/feedback/avatar pairs and 3:1 field/focus boundaries.
- The exact native preview passes compiled normal and largest-text hierarchy checks with no failures/skips. Both exercise the four main tabs, import disclosure and profile sections, retaining 44 pt minimum target assertions. Screenshots are inspected. The offline journey's initial run hit a retained XCTest navigation handle after a redirect; the view was visible and a separate native tap journey passed. The helper now resolves the current navigation element on each poll with the same hittability requirement. The corrected full journey passes on a fresh simulator in **276.685 seconds**, with zero failures/skips. It checks exact saved names/email/notes, draft recovery, plan completion, reminder snooze/completion and the default-off device lock through process restarts. The initial failed result is retained. Normal and largest-text hierarchy cases take 23.866 and 25.143 seconds respectively.

Local Expo SDK 57 compilation requires a newer Xcode than this Mac's app toolchain. This preview refreshes JavaScript in the independently verified compatible **1.0.0/build 12** binary from native source `3c5e6cce21889aded7ce6e4cacef722c3461ff85`. The bundle guard compares all native dependencies, configuration, modules and assets against that source, and records committed native/domain/design JavaScript. It does not claim a newly compiled native binary. Shared design changes also trigger the native CI workflow.

## Phone package and delivery

| Item | Value |
| --- | --- |
| UI JavaScript source | `b5ca465661e523499fca0c8f8bf3bb0025eebaa4` |
| Native binary source | `3c5e6cce21889aded7ce6e4cacef722c3461ff85` |
| Bundle SHA-256 | `bdf2993a6130e50c507b37a6eb614954ea2f52293cbd8c26e6dd7810e4b7e91e` |
| Signed IPA SHA-256 | `a9c6f7b4370156570f82513f83d30cf95426a542d1d2daba4f8009de54375b67` |
| Local package | `apps/mobile/build/releases/Everclose-Modern-Warm-b5ca465.ipa` |
| Extracted verified app | `apps/mobile/build/releases/modern-warm-b5ca465-verified/Payload/Everclose.app` |

The device package uses the existing Apple development profile/certificate, without exporting a private key or creating developer resources. Independent verification of the extracted final IPA passes with system Keychain access. Its bundle is byte-identical to the tested simulator preview, and its release receipt/hash match. The first restricted signature check lacked access to system trust; the durable receipt was corrected to record success only after the permitted strict verification passed.

The verified package was **installed in place on TIE Fighter**. Fresh metadata reports Everclose `com.fernandoamaral.bonds`, version 1.0.0/build 12. No uninstall, app-data reset, owner database copy or provider authorization was performed. iOS initially denied opening the app because the phone was locked; installation itself succeeds. A requested unlock is pending for the launch/process check; a final lock-state read still reports `passcodeRequired: true`. These checks do not claim owner field equality or a Google/provider round trip.

The earlier owner-ready simulator still retains its preceding `1ccab87` interface and data; these design checks use separate synthetic-only simulators. Production still runs the separately deployed Calendar-only server. The updated full web branch is **not deployed**. Google data OAuth, Gmail migrations, provider pilots and public distribution remain separate work described in the existing development plan.

Durable local evidence is in the ignored `apps/mobile/build/native-ui/modern-warm-b5ca465/`, `apps/mobile/build/releases/modern-warm-*.json` and `apps/mobile/build/design-*.log` paths. No private contact database or account screenshot is included in the design assets or Git.
