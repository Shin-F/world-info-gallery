# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-08-23
### Fixed
- Clicking anything in a context menu no longer closes the World Info panel. SillyTavern dismisses drawers on clicks outside them, and the check runs on DOM containment against a whitelist of selectors (`#world_popup`, `.popup`, `.ui-widget`, …) — the extension's menus were mounted at the document level, matching nothing, so every menu click counted as "outside" and dismissed the drawer behind it. Menus anchored inside the panel now mount inside it, making them part of the panel for that check. (Invisible to ProbablyTooManyTabs users, whose tabs never auto-close; most visible when linking several chat lorebooks in a row.)

## [1.2.1] - 2026-08-23
### Fixed
- Linking a chat lorebook from the card menu no longer closes the gallery. SillyTavern fires synthetic change events on the World Info editor's book selector during programmatic refreshes (including the editor refresh that follows a chat-binding save), and the extension was treating those as user selections — switching the view to the native editor. View switching now reacts only to real user interaction with the selector.
- The Settings-tab chat Link/Unlink button works — its toggle argument was inverted (it invoked the remove path when linking, and vice versa), so it silently did nothing. Present since the first release; only noticeable once chat bindings became usable.
- Binding rows in the popup's Settings tab refresh immediately after any binding action, instead of showing stale state until reopened.

## [1.2.0] - 2026-08-23

*(This release bundles the previously unpublished 1.1.1 – 1.1.3, which resolve the binding-detection reports from the issue tracker.)*

### Added
- **"Current" filter chip** — shows only the lorebooks that would inject into the prompt right now: the Global selection, the active persona's book, the current character's primary and additional books, and the current chat's binding
- Character binding menus pin the current chat's character at the top ("Current: …"), so the most common case is one click away; character and persona menus with long lists get an inline filter box
### Fixed
- Chat-bound lorebook covers are now stable: they derive from the character that owns the binding chat, so the image no longer changes when you switch or close chats — including books from past chats after a "Scan all chats" run (group-chat bindings have no single character and keep the placeholder)

## [1.1.3] - 2026-08-23

### Added
- **Remembered chat links** — chat-linked lorebooks keep their chat badge after you leave the chat. Links are remembered automatically as chats are opened or linked, self-heal when a chat is re-opened without the binding, and migrate with renames
- **"Scan all chats"** action (Extensions settings) — backfills remembered links from the entire chat history in a single request
- "Forget chat links" action in the card menu; card tooltips now show how many chats link each book
### Fixed
- Chat bindings read live state: lorebooks bound to the current chat are detected out of the box, "Link / Unlink current chat" enables whenever a chat is open, and linking persists properly. (The extension previously cached SillyTavern's context at startup — SillyTavern replaces the chat-metadata object on every chat switch, and chatId/characterId were captured before any chat loaded)
- Auxiliary character lorebooks and chat-bound lorebooks now derive a character avatar for their cover instead of falling back to the placeholder
- Token counts re-validate when the API mode changes mid-session (same stale-context cause)

## [1.1.2] - 2026-08-23

### Fixed
- Toggling Global from the gallery or popup now genuinely activates the book at prompt time and persists across reloads — and no longer displaces previously active books. The write goes exclusively through SillyTavern's official `updateWorldInfoSettings` API; a supplementary UI sync had been firing a synthetic change event on the Active Worlds selector, whose native handler re-derived (and clobbered) the active list from the select2-backed DOM

## [1.1.1] - 2026-08-23

### Fixed
- Lorebooks already active in Global World Info are detected out of the box (badges and filter counts) — SillyTavern moved World Info settings behind module accessors and removed them from the extension context; all reads and writes now use the live module exports and the official `updateWorldInfoSettings` API
- Additional (auxiliary) character lorebooks: books attached natively are detected, and "Add as additional lorebook" links correctly
- Renaming a book now also relinks its Global selection and additional character lorebooks
### Added
- Chat-bound lorebooks without a custom cover derive their card image from the current chat's character

## [1.1.0] - 2026-08-21

### Added
- **Character filter editor** in the entry popup, replacing the plain text input:
  - Avatar chips for every character, with a search box for large rosters
  - Tag chips using your native tag colors
  - Click a chip to cycle its state: include → exclude → off
  - On SillyTavern builds with the reworked filter model: three-state chips (one of / required / excluded) and persona chips, enabled automatically
  - Selections that no longer resolve (deleted characters or tags) appear as removable "⚠" ghost chips
  - Filter selections participate in draft protection, like every other field
- **Placeholder covers** for books without images: first letter, word initials (up to three), or the classic book icon — new option in the extension settings panel

### Changed
- Character filters saved from the popup now use SillyTavern's exact identifier conventions (avatar filenames without extension, tag IDs), so popup-created filters behave identically to native ones

## [1.0.0] - 2026-08-20

Initial public release.

### Added
- **Gallery-first World Info tab** — the tab opens on a card grid of every lorebook with covers, entry counts, token counts, and binding badges; filter chips (All / Persona / Character / Chat / Global / Unbound), text search, and sorting by name, entries, or tokens. Gallery-as-default is toggleable, and the native editor remains one click away and fully intact.
- **Book detail popup** — click a card to open it: sidebar with cover (click to change), inline rename, live stats, binding badges, and quick actions (Native editor, Global toggle, Export, Duplicate); an Entries tab with folders and the full entry editor; a Settings tab with binding management, manual labels, cover options, and Lorebook Manager import.
- **Bindings & classification** — badges derived from live bindings; assign or remove persona, character (primary and additional), chat, and Global bindings from card menus or the popup; renaming a book relinks every binding that referenced the old name.
- **Entry folders** — collapsible, drag-reorderable folders; drag entries between folders; folders are stored inside the lorebook file (`entry.extensions.lorebook_folder`), so they survive export/import and travel with the book; Lorebook Manager compatible (automatic import, two-way sync); a folder filter bar is also added to the native editor.
- **Full entry editor** in the popup — all native fields: title, keys with logic, content with live token counter, all eight insertion positions, order/depth/role, constant & vectorized, matching options, six extra scan sources, probability, inclusion groups, timed effects, recursion options, automation ID, and character filters.
- **Lorebook file operations** — import (multi-file, name-collision safe, legacy format normalization), export, duplicate, rename, create, delete.
- **Real token counts** — based on the active tokenizer and SillyTavern's token cache: per card, per entry, and per book, plus a live counter while editing; falls back to a clearly marked estimate if the tokenizer is unavailable.
- **Draft protection** — unsaved edits are marked with a dot, survive list rebuilds, searches, and renames; closing the popup with unsaved edits asks for confirmation on every close path.
- Extension settings panel: gallery as default view, token counts, avatar-derived covers.

<details>
<summary><strong>Pre-release development history (local builds, never published)</strong></summary>

### 0.3.0
- Book detail popup (Character Library–style) with Entries / Settings tabs
- Folder storage moved to the Lorebook Manager–compatible `entry.extensions.lorebook_folder` field, with automatic one-time import of existing Lorebook Manager folders and write-back mirroring
- Entry editor expanded to full native-field coverage; entries collapsible; drag-and-drop between folders
- Lorebook rename (endpoint with create/copy/delete fallback)

### 0.2.0
- Gallery view with view toggle and gallery-default mode
- Binding badges, filters, search, sort; cover upload with server-side storage; avatar-derived covers
- Folders v1 (top-level `wig_folder` field — migrated to the portable field in 0.3.0)

### 0.1.0
- Project scaffold: manifest, entry script, styles, settings template

### Unversioned fixes during development
- Popup constructed with the correct context API (`POPUP_TYPE`, options in the fourth argument)
- Popup views re-render from live data instead of stale snapshots (`loadWorldInfo` returns deep clones)
- Empty folders render and persist until explicitly deleted
- Context menus mount inside open ST popups (native `<dialog>` top layer) and position correctly under theme transforms
- Compatibility with SillyTavern's refactored World Info server API (create/rename endpoints removed; book writes go through `/api/worldinfo/edit`)
- Install-folder detection via module URL, so the extension works from any repo/folder name
- Entry expand/collapse state machine and toolbar wrapping fixes

</details>

[1.1.0]: https://github.com/Shin-F/world-info-gallery/compare/v1.0.0...v1.1.0
[1.1.0]: https://github.com/Shin-F/world-info-gallery/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Shin-F/world-info-gallery/releases/tag/v1.0.0
