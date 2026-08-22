# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/Shin-F/world-info-gallery/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Shin-F/world-info-gallery/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Shin-F/world-info-gallery/releases/tag/v1.0.0
