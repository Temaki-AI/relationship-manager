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
| Person | Native editing and imported-source cards precede conversations and reminders. | Use Overview, Activity, and Details. Keep primary contact details and capture in Overview; move editing and source inspection to Details; put confirmed history in Activity. Preserve source provenance and all editing routes. |
| Calendar | The date-navigation row can exceed the width of a small phone. Native Agenda and Reminders look like separate products. | Wrap date controls at narrow widths, retain the phone agenda default, and use Calendar as the native destination with an All reminders action. |
| Settings | Destructive and technical recovery tools occupy the main settings page at full size. Native account options have the same weight as syncing. | Disclose encrypted download, restore, erasure, advanced account controls, and email storage. Unfinished restore/erasure remains visible and its controls automatically expand. Keep sync failures and conflict actions visible. |
| Onboarding and forms | Oversized, abstract introductions obscure simple tasks. | Shorten the first-run and add-person introductions. Keep existing draft recovery, validation, confirmation, and account boundaries. Put custom native server selection behind an explicit disclosure. |
| Accessibility and sizing | Web buttons can be 32–36 pixels high; native inactive text is faint; tab-bar inset is hard coded. | Give shared web actions and primary navigation at least 44-pixel targets, add a skip link, improve native faint text contrast, derive the tab bar from safe-area insets, allow native quick-capture buttons to wrap, and use 16-pixel web inputs on phones to avoid focus zoom. |

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

Current status: source changes, mobile type checking/lint, the 22 mobile unit
tests, and iOS export pass. The rebuilt local web preview is running with test
data. The expanded responsive and compiled-native runtime checks are in progress.
This is not yet a claim of completed production or phone delivery.

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
