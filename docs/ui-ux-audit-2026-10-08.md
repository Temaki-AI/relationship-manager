# Everclose interface audit — 8 October 2026

The main problem is competing priorities. A person looking for one contact or
one next action has to pass navigation duplicates, import controls, setup copy,
statistics, and account administration. This is especially expensive on a phone.

## Decisions and changes

| Area | Finding | Change |
| --- | --- | --- |
| Navigation | Mobile web uses bottom tabs, a second navigation menu, and section tabs. Native tabs use different destinations. | Use Today, People, Calendar, and Settings on both platforms. Keep web creation in the header. Put native reminders under Calendar with a standard back route. Keep collection and integration links in their existing sections. |
| Today | Large introductions, onboarding, metrics, and privacy cards compete with the queue. | Show the daily queue first. Use a short title and greeting. Disclose setup and relationship statistics on request. Preserve separate reach-out, logging, completion, and snooze behavior. |
| People | iOS puts three contact-access/import tools ahead of the directory. Web exposes selection and display options alongside the main task. | Put iPhone import tools behind a labeled disclosure. Put web display and bulk tools in Manage, make the compact directory the default, and disclose group filters. Retain saved view preferences and URL-controlled search/filter/page state. |
| Person | Native editing and imported-source cards precede conversations and reminders. Web generated suggestions and duplicate contact links obscure saved notes. | Use Overview, Activity, and Details. Keep primary contact details, saved notes, and capture in Overview; move editing and source inspection to Details; put confirmed history in Activity. Disclose generated conversation suggestions. Show each primary method once while retaining its label and phone country; suppress legacy social links already represented by profile methods. Preserve source provenance and all editing routes. |
| Calendar | The date-navigation row can exceed the width of a small phone. Native Agenda and Reminders look like separate products. | Wrap date controls at narrow widths, retain the phone agenda default, and use Calendar as the native destination with an All reminders action. |
| Settings | Destructive and technical recovery tools occupy the main settings page at full size. Native account options have the same weight as syncing. | Disclose encrypted download, restore, erasure, advanced account controls, and email storage. Unfinished restore/erasure remains visible and its controls automatically expand. Keep sync failures and conflict actions visible. |
| Onboarding and forms | Oversized, abstract introductions obscure simple tasks. | Shorten the first-run and add-person introductions. Keep existing draft recovery, validation, confirmation, and account boundaries. Put custom native server selection behind an explicit disclosure. |
| Accessibility and sizing | Web buttons can be 32–36 pixels high; native inactive text is faint; tab-bar inset is hard coded. Largest iOS text clips decorative initials, the add icon, and horizontal profile tabs. | Give shared web actions and primary navigation at least 44-pixel targets, add a skip link, improve native faint text contrast, derive the tab bar from safe-area insets, allow native quick-capture buttons to wrap, and use 16-pixel web inputs on phones to avoid focus zoom. At large native text sizes, stack profile tabs and put the directory status below the name. Keep decorative glyphs fixed, allow headings/control labels to scale up to 2×, and leave body content at the user's full text scale. |

The warm Everclose colors remain. Secondary actions have quieter surfaces,
smaller headings, and less repeated introductory copy. No database, sync,
authorization, source-matching, recovery, or notification rules are changed.

## Coverage and acceptance checks

The route inventory includes web authentication and device connection, Today,
the directory and its collections, person profiles/forms/methods/sources,
Calendar and event context, reminders, import/export and duplicate review,
Google Contacts/Calendar/Gmail and LinkedIn review, and settings/recovery.
Native routes additionally include permission policies, device contact preview,
photos, offline change review, Apple Calendar publication, and background locks.
Changes concentrate on the common shell, daily screens, profiles, forms, and
settings. Integration permission and write-confirmation screens retain explicit
review steps; simplifying these must not obscure what will be read or written.

Verification uses disposable local and simulator workspaces. Personal databases
and signed-in production workspaces are excluded from mutation tests.

- Responsive browser audit: Today, People, profile, Calendar, reminders, groups,
  smart lists, settings, connections, new/edit person, and duplicate review at
  320, 393, 768, and 1280 pixels. Check horizontal overflow, all four main
  destinations, primary target sizes, and WCAG-tagged automated checks.
- Browser tasks: navigate collection sections; create a reminder from Add;
  choose a person to log a moment; open/resume a person form; change directory
  view; disclose imports and backup/restore; retain search/filter history.
- Native tasks: first-run/local-only entry; create a person; preserve a draft
  and saved data across restart; create and complete a plan; create, snooze,
  and complete a reminder; reach settings; inspect all three profile sections.
- Native large text: repeat primary navigation, disclosure, and profile checks
  at the largest accessibility content size, and inspect screenshots for
  clipping and obscured controls.

The import shortcut now consumes its URL intent once, with a visible close
action. Closing or completing an import can return to the directory. Entering
bulk selection also exposes Done selecting without reopening Manage.

Browser results:

- All 48 responsive screen renders pass overflow, primary navigation sizing,
  and WCAG-tagged Axe checks at the four widths. Saved captures are under
  `build/ui-audit-2026-10-08/`. These checks audit selected rendered states;
  they do not replace manual accessibility testing of every scroll position.
- The 24 local browser cases covering hierarchy, navigation, authentication,
  forms, method editing, duplicate merging, and CSV/vCard portability pass
  collectively: 20 in the final selected run and four in the corrected transfer
  rerun. Earlier full local coverage passed 132 cases with 36 mode-specific
  skips; its four stale duplicate/export assertions are covered by that rerun.
- The 44 selected Google-mode browser journeys and four additional method
  cases pass collectively. The initial batch passed 34/44. Corrected tests
  follow the new Manage/disclosure routes and current labels; the profile
  change removes a real duplicate legacy website link. The corrective batch
  passed 20/24, and all eight final onboarding/profile/method checks passed
  after correcting a heading and replacing a network-idle wait on a page with
  background requests. Fixtures use disposable routed data and simulated
  providers; no owner Google grant or live provider write is exercised.
- Root lint and the final Google-mode Next build pass. CI at `1ccab87` passed
  962/964 root cases; the remaining two static contracts expected the removed
  More menu and old logout text. Both corrected files pass all ten cases while
  preserving session-clearing and accessibility assertions. This is collective
  coverage, not a claim that the final head has completed its full CI run.

Native UI source `1ccab87d7acdb6d19d4d0a8f9ca913496245ff00` passes type checking,
lint, the 22 mobile unit cases, Hermes export, and compiled simulator checks of
the main destinations, import disclosure, and all profile sections at normal
and maximum accessibility text sizes. Screenshots were inspected after the
large-text adjustments. The original native binary remains from the verified
build-12 source `3c5e6cce21889aded7ce6e4cacef722c3461ff85`; dependency/config/module
compatibility checks pass before refreshing its JavaScript bundle.

Fresh [iOS CI 37707487119](https://github.com/Temaki-AI/relationship-manager/actions/runs/37707487119)
also passes at `1ccab87`: both Release compilations, simulator startup with
real SQLite migration, and the offline journal journey. Those compiled
artifacts are distinct from the locally installed, compatible bundle refresh.

The tested preview is installed in place in the user-ready simulator
`AAC8EF14-F696-416B-ACBF-6706D5EF8B77`. Every row in all 26 SQLite tables is
unchanged by installation; schema 18, integrity, and foreign-key checks pass.
The installed bundle hash matches its release receipt. The inspected launch
screen retains the owner's unfinished Google connection. No synthetic contacts
were added to that workspace. Separate disposable browser and simulator
workspaces contain the verification fixtures.

The exact native preview passes three compiled XCTest journeys with zero
failures or skips: normal-text hierarchy (22.935 seconds), largest accessibility
text hierarchy (24.050 seconds), and the complete offline journal journey
(277.162 seconds). Results are retained under
`apps/mobile/build/native-ui/ux-audit-b10bbec/` as
`hierarchy-final-normal.xcresult`, `hierarchy-final-largest.xcresult`, and
`offline-final-1ccab87.xcresult`. The offline case checks first-run local entry,
person creation, notes/drafts across restart, plan completion, and reminder
creation/snooze/completion across restart. These are simulator checks; they do
not certify physical provider permissions or an owner Google round trip.

The signed phone candidate is
`apps/mobile/build/releases/Everclose-UI-preview-1ccab87.ipa`. Independent
extraction, strict signature verification, and receipt checks pass. Its
JavaScript bytes exactly match the tested simulator bundle:
`bb15467a3a8c30e33e21541f30e97795afafed81706df3fe4207b38285ae9341`.
The final IPA SHA-256 is
`b3ab54868c1d3a0a1cd512e6c595680c26d9493275a8f1ac38322261e8d2dc31`.
It reuses the compatible compiled build-12 native binary; it is not a newly
compiled native release or a TestFlight upload.

This UI update is in the existing draft PR; it has not been deployed to the live
Cloudflare site. The physical iPhone's current connection has no usable tunnel,
so its previously installed build 12 has not been replaced by this UI preview.

## Design references

- [Apple UI design tips](https://developer.apple.com/design/tips/): clear
  hierarchy, readable content, and 44-point touch targets.
- [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars):
  stable primary destinations.
- [Progressive disclosure, Nielsen Norman Group](https://www.nngroup.com/articles/progressive-disclosure/):
  show secondary tools when requested.
- [WCAG 2.2 target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html):
  the AA minimum is 24 pixels with specified spacing exceptions; the 44-pixel
  web target used here is a more comfortable internal goal.
- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/): versioned native API
  and runtime constraints used for the implementation.
