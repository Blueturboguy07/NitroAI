# NitroAI UI Spec

Layout-parity spec derived from reference screenshots in `docs/ui-reference/`
(11 captures, July 19 2026 — **gitignored, never commit**). We replicate layout,
geometry, spacing, and interaction patterns with our own brand: name/logo/icons
are original, the commercial Clarika font is substituted with Quicksand
(headings/UI) + Nunito (body), and no "Turbo" marks appear anywhere.

## Design tokens

Implemented in `src/styles/theme.css` as semantic CSS variables swapped by
`[data-theme]` on `<html>`.

| Token | Light | Dark |
|---|---|---|
| accent | `#6923ff` | same |
| accent-soft (Share btn, banners) | `#dcc8fb` | `#4c2a99` |
| accent-softer (disabled CTA, icon chips) | `#f3ecfd` | `#2c2140` |
| bg | `#ffffff` | `#18181b` |
| panel (sidebar, inputs) | `#fafafa` | `#1f1f23` |
| card | `#ffffff` | `#232327` |
| edge (borders) | `#e4e4e7` | `#33333a` |
| ink / ink-dim / ink-faint | `#27272a` / `#71717a` / `#a1a1aa` | `#f4f4f5` / `#a1a1aa` / `#71717a` |
| callout (empty states) | bg `#faf3cd`, icon `#8a6d1a` | bg `#3a3423`, icon `#e6cf6b` |

Geometry: cards `rounded-2xl` (1rem) + 1px edge border + soft shadow; modals
1.25rem radius + heavy shadow; tabs and toggles are pill-shaped; primary CTA is
full-width accent with white bold text, disabled state = accent-softer bg +
faint text.

## Surfaces

### Dashboard (`/`)
- Sidebar 256px (64px collapsed): logo row + collapse chevron; nav Dashboard /
  Settings (Study Guides intentionally dropped); bottom: Theme toggle, profile
  row. Their purple "Upgrade to Premium" block is omitted.
- Main: `Dashboard` H1 (36px bold) + "Create new notes" subtitle; search field
  top-right ("Search (⌘K)").
- 4 creation cards in a row (2×2 below xl): icon chip + title + subtitle +
  chevron → Blank document / Record or upload audio / Document upload / Website
  link.
- Pill tab group "My Notes" | "Shared with Me"; "New Folder" button right.
- Notes list grouped by "Today" / "Earlier": rows with source icon (YouTube
  red, DOC purple, mic), title, "Last opened X ago", kebab menu.

### Create-note modal (all three sources)
560px centered card: top-right X; centered 64px source icon (YouTube red / DOC
purple / mic purple); "Create note from source" heading; source body:
- link → single URL input "Paste a website or YouTube link..."
- document → dashed dropzone "Drag documents here, or click to upload"
- audio → "Make a recording" panel (Select microphone button, mic circle +
  dotted waveform line) then "Or" divider then audio dropzone "(MP3, WAV, etc.)"
Footer: full-width "Generate Notes" CTA, disabled until input present.

### Note view (`/notes/:id/:view`)
- 64px icon rail: hamburger (back), then 5 view icons — editor doc / chat
  bubble / podcast mic / flashcards stack / quiz checklist; bottom palette
  (theme) + avatar. Active icon = card bg + shadow.
- **Editor**: top bar — document title, history icon, accent-soft "Share"
  pill, kebab. Body = block editor, placeholder "Type / for command menu"
  (Tiptap arrives M1). Right side: 420px collapsible assistant panel — expand
  + collapse controls top; centered "Hey, I'm Nitro" + "I can work with you on
  your doc and answer any questions!"; chat input pinned under hero.
- **Chat**: full-page hero "Hey, I'm Nitro" (48px) + "Ask me anything about
  the source material." + wide chat input.
- **Chat input** (shared component): rounded-2xl card; text field with
  placeholder "Type a question here or type '@' to reference documents...";
  bottom row: paperclip (accent) left; mic + arrow-up send (rounded square)
  right.
- **Podcast**: "✨ Welcome to Podcasts ✨" + "Listen to your notes and bring
  them to life."; empty state = yellow callout "Document is empty!" + body
  explaining podcasts generate from the note's content.
- **Flashcards**: "Welcome to Flashcards" + "Study your notes with spaced
  repetition." + same callout pattern.
- **Quiz**: not captured in reference screenshots — layout mirrors the other
  empty states for now. TODO(M0): capture quiz view, flashcard learn-mode
  states, podcast player with content, slash menu, Learn Mode walkthrough.

### Settings (`/settings`)
- Header: gear + `Settings` H1 + subtitle.
- Left card: accent-soft banner, overlapping avatar with camera-edit button,
  name + pencil, Language field, data-folder field with copy button. (Their
  Email / User ID / Log Out are cloud-account concepts — replaced by a "Local
  account" line.)
- Right column: their Subscription card is repurposed as the **AI Engine card**
  — Local/Cloud pill toggle, BYO key input (keychain-backed, prefix
  auto-detect), local model manager entry. Their Access Code and Pre-Generated
  Notes cards are dropped. About card notes AGPL + export-freedom.

### Onboarding (`/onboarding`, first run)
Centered: logo, "How do you want your AI to run?", two mode cards (Fully local
— recommended; Bring your own key + key input with provider badge), full-width
"Get started" CTA. No account creation anywhere.
