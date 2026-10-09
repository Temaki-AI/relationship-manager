# Everclose · Modern + Warm

The approved direction combines a clean mobile layout with a warm, personal palette. Ivory surfaces, charcoal sans-serif type and deep rose actions carry the interface. Pastel avatars bring warmth to lists. The visual reference is [the approved concept](design/modern-warm-reference.png); it is a direction, not a source of contact data.

The implemented component reference is available at `/design-system` inside an authenticated web workspace. Its names and field values are explicitly illustrative. Today, People, Calendar and Settings remain the four main destinations across web and iPhone.

## Foundations

The source of truth is [`packages/design/src/tokens.ts`](../packages/design/src/tokens.ts). Web generates `app/design-tokens.css`; Tailwind consumes its semantic variables and the shared type/radius/motion values. Native imports the same tokens through `apps/mobile/src/theme.ts`.

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#FCF8F3` | Page background |
| Surface | `#FFFDFA` | Cards, fields, navigation |
| Warm surface | `#F5EEE7` | Quiet context and nested content |
| Ink / muted ink | `#2C2527` / `#736667` | Primary / supporting text |
| Primary / pressed | `#B72C52` / `#94223F` | Primary actions and focus |
| Soft rose | `#F9E3E8` | Secondary action and selection |
| Success | `#24664B` on `#E4EFE7` | Confirmed saved/synced state |
| Warning | `#865116` on `#FBEDD2` | Pending choices and review |
| Error | `#AA2929` on `#FBE7E3` | Failure and destructive context |
| Information | `#335572` on `#EAF0F5` | Neutral status and offline context |
| Field boundary | `#9C8077` | Visible input outline |
| Divider | `#E8DFD8` | Noninteractive separation |

Pastel rose, sage, peach, lavender and sky have their own dark foregrounds. `avatarTone(name)` selects one consistently across platforms. Avatar colors convey identity, never relationship health, urgency or permissions. Existing photos take precedence.

| Type role | Size / line height | Weight |
| --- | --- | --- |
| Page title | 32 / 40 | 700 |
| Section | 20 / 28 | 600 |
| Body | 16 / 24 | 400 |
| Control label | 15 / 22 | 600 |
| Caption | 13 / 20 | 400 |

Web uses the system sans-serif stack. iOS uses the built-in Avenir Next family, with a sans-serif Android fallback. No downloaded font is needed. Page headings stay concise. Supporting text may wrap; important actions never rely on truncation.

Spacing follows a 4 px rhythm: 4, 8, 12, 16, 20, 24, 32, 40 and 48. Page gutters use 16–20 px on phones and wider space on desktop. Default card padding is 20–24 px. Controls use 12 px corners, cards 20 px, dialogs 24 px, and pills/avatars remain round. Cards have one subtle warm shadow; menus and overlays use the stronger overlay shadow. Dividers do not acquire shadows.

Motion is 120 ms for quick feedback, 180 ms for state changes and 240 ms for entrance. Web respects `prefers-reduced-motion`. Native feedback uses opacity and small pressed-state changes, with no custom looping motion. Avoid decorative gradients or stacked shadows in daily screens.

## Components and behavior

| Component | Web | iPhone | Rules |
| --- | --- | --- | --- |
| Card / surface | `components/ui/card.tsx` | `Surface` | Warm surface, fine divider, shared radius/elevation |
| Primary action | `Button` default | `ActionButton` primary | Rose with white label; one main action per task |
| Secondary action | `Button` secondary | `ActionButton` secondary | Soft rose with rose label |
| Quiet action | `Button` ghost/link | `ActionButton` quiet | Text action with a full touch target |
| Destructive action | `Button` destructive | `ActionButton` destructive | Error red; keep existing explicit confirmation/recovery behavior |
| Text field | `Input`, `Textarea` | `FormInput` | Persistent label, visible boundary, rose focus, error text and red boundary |
| Avatar | `Avatar` | `Avatar` | Photo or stable pastel initials; decorative image when adjacent name exists |
| Status | `Badge`, toast, `LoadError` | `StatusPill`, existing alerts | Text describes status; color reinforces it |
| Disclosure | `Disclosure`, semantic `details` | `Disclosure` | Optional detail hidden initially; expansion announced |
| Navigation | `NavHeader` | native tabs | Today, People, Calendar, Settings in the same order |

Controls have normal, pressed/hover, focused and disabled states. Disabled controls prevent interaction and show a subdued appearance; pending actions keep useful text such as “Saving…”. Focus stays visible. Validation pairs `aria-invalid` and linked error text on web; native fields support `invalid`, retain accessibility labels and pair errors with explanatory text. Do not erase a draft after a failed save. Loading, empty, error, offline, saved and confirmation experiences use the same foundations.

Native `FormInput` preserves the caller's keyboard type, input limit, focus/blur callbacks, ref and draft handlers. Multiline inputs grow from 96 px. Existing data mutations, OAuth, contact methods, integration review, conflict handling and confirmation guards remain owned by their existing features.

## Responsive and accessible layout

On web, the main navigation moves to the bottom below 768 px, with safe-area space. At 768 px and above it is in the header. Forms collapse to a single column on phones, and People uses its compact list by default. Calendar offers its existing phone agenda. The profile keeps Overview, Activity and Details. Secondary tools are progressively disclosed.

Touch targets must be at least 44 × 44 px; shared native actions and fields prefer 48 px height. Do not fix the height of a container that holds scalable text. Native supports Dynamic Type and wraps action rows; tested headings/control labels may cap at 2× while body text continues to scale. Decorative initials do not scale. Accessibility remains a behavior requirement, not just a color choice.

Shared text pairs meet WCAG AA 4.5:1. Field/focus boundaries meet 3:1; pale dividers are not input boundaries. Web checks cover 320, 393, 768 and 1280 px with Axe, horizontal overflow and navigation targets. Native checks cover normal and the largest accessibility text size, plus the offline create/edit/plan/reminder journey. Status must never be communicated by color alone.

Write in a friendly, direct voice: “Add someone”, “A detail to remember”, “Your day is clear”. Use specific recovery guidance when something fails. Avoid pressure, gamification and promises that opening another app records a conversation.

## Maintenance

1. Change semantic foundations in `packages/design/src/tokens.ts`.
2. Run `npm run design:tokens` and inspect `/design-system`.
3. Use shared components before adding local style. Add variants only when a recurring behavior needs them.
4. Run design/contrast contracts, web/mobile type and lint checks, responsive Axe tests and the affected native journeys.
5. Changes under `packages/design` trigger the native build workflow and are included in the native bundle's committed-source guard.

The implementation changes presentation only. Releasing the web design to production is a separate deployment; the hosted Calendar-only server and outstanding provider consent work must be considered before publishing the full branch.
