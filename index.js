// =====================================================================
// World Info Gallery — gallery-first lorebook browser with a detail
// popup, folders (Lorebook Manager compatible), and binding management.
// Compatible with Moonlit Echoes (theme vars only) and ProbablyTooManyTabs
// (all UI is injected inside #world_popup or shown in ST Popups).
// =====================================================================

const MODULE_NAME = 'worldinfo-gallery';   // unchanged — keep reading, this matters
// The install folder is whatever ST's installer cloned the repo as
// (third-party/<repo-name>) — it needn't match anything hardcoded. Detect it
// from this script's own URL so GitHub installs, manual installs, and local
// dev folders all work. (Extension scripts are ES modules, so import.meta
// is available; the unanchored regex tolerates reverse-proxy subpaths.)
const EXT_PATH = (() => {
    try {
        const m = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(third-party\/[^/]+)\//);
        if (m) return m[1];
    } catch { /* not a module / unexpected layout — fall back */ }
    return `third-party/${MODULE_NAME}`;
})();
const SETTINGS_KEY = 'WorldInfoGallery';
const LM_SETTINGS_KEY = 'lorebookFolders';      // Lorebook Manager / WI Drawer
const LM_FOLDER_FIELD = 'lorebook_folder';      // stored under entry.extensions
const LEGACY_FOLDER_FIELD = 'wig_folder';       // our own v0.2 field, migrated on sight
const UNSORTED = '__unsorted__';
const RESERVED = new Set(['__uncategorized__', 'uncategorized', UNSORTED]);

const ctx = SillyTavern.getContext();
// Chat state on the cached ctx is an import-time snapshot: chatId and
// characterId are plain values captured before any chat loads (so chat menu
// items read "no chat" and stay disabled forever), and chatMetadata is a
// dead reference — script.js REASSIGNS it on every chat switch (the ST
// extension docs warn about exactly this). getContext() builds a fresh
// object per call and is cheap; use it wherever current chat state matters.
const ctxNow = () => SillyTavern.getContext();
function chatOpen() {
    const c = ctxNow();
    return typeof c.getCurrentChatId === 'function' ? Boolean(c.getCurrentChatId()) : Boolean(c.chatId);
}
// ---- remembered chat bindings -------------------------------------------
// A chat's lorebook binding lives inside that chat's file (chat_metadata),
// which the client only holds for the currently open chat. To keep the chat
// badge after switching away, we remember every binding we observe, keyed by
// (owner, chatFile). Reconciled whenever a chat is opened: the live chat is
// truth — its descriptor is removed from every book, then re-registered
// under whatever its metadata names (if anything). A full scan (below) is
// authoritative and clears entries the incremental path could never see.

function chatOwnerKey() {
    const c = ctxNow();
    if (c.groupId) return `group:${c.groupId}`;
    return c.characters?.[c.characterId]?.avatar ?? null;
}

function noteChatBindings() {
    const c = ctxNow();
    const owner = chatOwnerKey();
    const file = String(c.chatId ?? '').replace(/\.jsonl$/, '');
    if (!owner || !file) return; // no live chat
    const s = getSettings();
    const book = c.chatMetadata?.world_info || null;
    const sameChat = (x) => x.o === owner && x.f === file;
    let dirty = false;
    for (const [name, arr] of Object.entries(s.chatBindings)) {
        if (!Array.isArray(arr)) continue;
        const kept = arr.filter((x) => !sameChat(x));
        if (kept.length !== arr.length) {
            if (kept.length) s.chatBindings[name] = kept;
            else delete s.chatBindings[name];
            dirty = true;
        }
    }
    if (book) {
        const arr = s.chatBindings[book] ??= [];
        if (!arr.some(sameChat)) { arr.push({ o: owner, f: file }); dirty = true; }
    }
    if (dirty) saveSettings();
}

const rememberedChatLinks = (name) => getSettings().chatBindings[name] ?? [];

function forgetChatBindings(name) {
    const n = rememberedChatLinks(name).length;
    delete getSettings().chatBindings[name];
    saveSettings();
    noteChatBindings(); // a live current-chat link immediately re-registers
    refreshPopupBindingUi(name);
    toast('info', `Forgot ${n} remembered chat link${n === 1 ? '' : 's'}.`);
}

// One request: /api/chats/recent { metadata: true } returns every chat file
// (all characters, groups, root) with its chat_metadata — the whole
// library's binding map in a single round trip. Verified against
// src/endpoints/chats.js: items carry { avatar } or { group }, file_id
// (extensionless), and chat_metadata.
async function scanAllChatBindings() {
    const res = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ metadata: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chats = await res.json();
    if (!Array.isArray(chats)) throw new Error('Unexpected response');

    const registry = {};
    for (const c of chats) {
        const book = c?.chat_metadata?.world_info;
        if (!book) continue;
        const owner = c.avatar ?? (c.group ? `group:${c.group}` : 'root');
        const file = String(c.file_id ?? String(c.file_name ?? '').replace(/\.jsonl$/, ''));
        if (!file) continue;
        (registry[book] ??= []).push({ o: owner, f: file });
    }

    const s = getSettings();
    s.chatBindings = registry; // full scan is authoritative — stale entries go
    s.lastChatScan = Date.now();
    saveSettings();
    noteChatBindings(); // merge the live (possibly unsaved) current chat back in
    renderGallery();
    if (state.bp) renderPopupHead();
    return { chats: chats.length, books: Object.keys(registry).length };
}
// POPUP_TYPE enum is a separate context export (Popup.Types does not exist)
const POPUP_TEXT = ctx.POPUP_TYPE?.TEXT ?? 1;
const ET = ctx.eventTypes ?? {};

const DEFAULTS = Object.freeze({
    galleryDefault: true,
    showTokens: true,
    deriveCovers: true,
    covers: {},            // worldName -> image path
    types: {},             // worldName -> manual label
    folderOrder: {},       // worldName -> [folderName, ...]
    collapsedFolders: {},  // worldName -> { folderName: true }
    lmImported: {},        // worldName -> true (auto Lorebook Manager import done)
	placeholderCover: 'letter',  // no-image covers: 'letter' | 'initials' | 'icon'
    lmImported: {},        // worldName -> true (auto Lorebook Manager import done)
    chatBindings: {},      // worldName -> [{ o: ownerKey, f: chatFile }] remembered chat links
    lastChatScan: 0,       // timestamp of the last "Scan all chats" run
});

const FILTERS = [
    ['all', 'All', 'fa-layer-group'],
    ['current', 'Current', 'fa-bolt'],
    ['persona', 'Persona', 'fa-user'],
    ['character', 'Character', 'fa-user-astronaut'],
    ['chat', 'Chat', 'fa-comments'],
    ['global', 'Global', 'fa-globe'],
    ['unbound', 'Unbound', 'fa-unlink'],
];

// world_info_position enum (current ST): 0 before char, 1 after char,
// 2 before AN, 3 after AN, 4 at depth, 5 EM top, 6 EM bottom, 7 outlet
const POSITIONS = [
    ['↑Char', 0], ['↓Char', 1], ['↑AN', 2], ['↓AN', 3],
    ['@Depth', 4], ['EM ↑', 5], ['EM ↓', 6], ['Outlet', 7],
];
const ROLES = [['System', 0], ['User', 1], ['Assistant', 2]];

const state = {
    view: 'gallery',
    filter: 'all',
    search: '',
    sort: 'name-asc',
    lastNames: [],
    selectMode: false,
    selection: new Set(),
    folderFilter: {},
    bp: null,              // open book popup: { name, dlg, tab, filter, sort, expanded:Set }
};

let renderSeq = 0;
const bookCache = new Map();
let cacheEpoch = 0;        // bumped on every cache invalidation; part of the render signature
let lastGallerySig = null; // last fully-rendered gallery signature (no-op render guard)
let lastGalleryUi = '';    // last [filter, search, sort] — gates scroll preservation

// ---------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const jq = (sel) => jQuery(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const estTokensFromLength = (len) => Math.ceil(len / 3.35); // ST's own guesstimate formula
const estTokens = (text) => estTokensFromLength(String(text ?? '').length);
const tokenLabel = (n, estimated) => `${estimated ? '~' : ''}${fmtTokens(n ?? 0)}`;

// Nearest ancestor of el that actually scrolls (the WI drawer content on desktop)
function scrollParentOf(el) {
    for (let p = el?.parentElement; p && p !== document.body; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (['auto', 'scroll', 'overlay'].includes(st.overflowY) && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
}

// Tokenizer identity: counts differ per tokenizer, so cached counts are keyed
// to (API, tokenizer setting, model). Any change forces a recount on next use.
function tokenizerKey() {
    try {
        return [ctxNow().mainApi, ctx.powerUserSettings?.tokenizer, ctx.chatCompletionSettings?.model].join('|');
    } catch {
        return 'unknown';
    }
}

let _countTokens; // undefined = unresolved, null = unavailable, function = ready
async function countTokens(text) {
    if (_countTokens === undefined) {
        let fn = null;
        if (typeof ctx.getTokenCountAsync === 'function') {
            fn = (t) => ctx.getTokenCountAsync(t, 0, false);
        } else {
            try {
                const s = await import('../../../script.js');
                if (typeof s?.getTokenCountAsync === 'function') fn = (t) => s.getTokenCountAsync(t, 0, false);
            } catch { /* try tokenizers.js next */ }
            if (!fn) {
                try {
                    const tk = await import('../../../tokenizers.js');
                    if (typeof tk?.getTokenCountAsync === 'function') fn = (t) => tk.getTokenCountAsync(t, 0, false);
                } catch { /* unavailable */ }
            }
        }
        _countTokens = fn;
    }
    // Third arg `full=false` (added in ST 2026-05) strips the ~6-token OpenAI
    // message wrapper so entries count as bare text. Ignored on older builds.
    if (!_countTokens) return null;
    try {
        const n = await _countTokens(String(text ?? ''));
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

function debounce(fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    return d;
}

function hueFromString(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

// First meaningful character of a word (skips punctuation/brackets/emoji),
// Unicode-aware via code-point iteration.
function firstLetterOf(word) {
    for (const ch of String(word)) {
        if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
    }
    return null;
}

// Placeholder text for cover-less books: first letter, or word initials
// (capped at 3). Null → fall back to the generic book icon.
function placeholderTextFor(name) {
    const style = getSettings().placeholderCover;
    if (style === 'icon') return null;
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    if (style === 'initials') {
        const initials = words.slice(0, 3).map(firstLetterOf).filter(Boolean).join('');
        if (initials) return initials;
    }
    return firstLetterOf(words[0]);
}

// Placeholder cover: big monogram on the name-derived gradient
function addCoverPlaceholder(cover, name) {
    const letter = placeholderTextFor(name);
    if (!letter) { addCoverIcon(cover); return; }
    const s = document.createElement('span');
    s.className = 'wig-cover-letter';
    s.dataset.chars = String([...letter].length);
    s.textContent = letter;
    cover.appendChild(s);
}

function toast(type, msg) {
    if (typeof toastr !== 'undefined' && toastr?.[type]) toastr[type](msg, 'World Info Gallery');
}

function safeThumb(type, file) {
    try { return ctx.getThumbnailUrl(type, file); } catch { return null; }
}

// ---------------------------------------------------------- settings
function getSettings() {
    const all = ctx.extensionSettings;
    if (!all[SETTINGS_KEY]) all[SETTINGS_KEY] = {};
    const s = all[SETTINGS_KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}
const saveSettings = () => ctx.saveSettingsDebounced();

// ---------------------------------------------------------- folder model
// Canonical storage: entry.extensions.lorebook_folder (portable, Lorebook
// Manager compatible). Legacy wig_folder is read as a fallback and migrated.
function folderOf(entry) {
    const ext = entry?.extensions?.[LM_FOLDER_FIELD];
    if (typeof ext === 'string' && ext.trim()) return ext.trim();
    const legacy = entry?.[LEGACY_FOLDER_FIELD];
    if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
    return null;
}

function setEntryFolderField(entry, folder) {
    if (folder) {
        entry.extensions = (entry.extensions && typeof entry.extensions === 'object') ? entry.extensions : {};
        entry.extensions[LM_FOLDER_FIELD] = folder;
    } else if (entry.extensions) {
        delete entry.extensions[LM_FOLDER_FIELD];
        if (Object.keys(entry.extensions).length === 0) delete entry.extensions;
    }
    if (Object.hasOwn(entry, LEGACY_FOLDER_FIELD)) delete entry[LEGACY_FOLDER_FIELD];
}

function lmWorldState(book) {
    const w = ctx.extensionSettings?.[LM_SETTINGS_KEY]?.worlds;
    return (w && typeof w[book] === 'object') ? w[book] : null;
}

// Keep Lorebook Manager's uid map in sync when it tracks this book, so both
// extensions agree even after we move an entry.
function mirrorToLM(book, uids, folder) {
    const st = lmWorldState(book);
    if (!st) return;
    st.entries ??= {};
    for (const uid of uids) st.entries[String(uid)] = folder ?? '';
    if (folder && Array.isArray(st.folders) && !st.folders.some((f) => String(f.name).toLowerCase() === folder.toLowerCase())) {
        st.folders.push({ name: folder, order: st.folders.length });
    }
    saveSettings();
}

function orderedFolders(book, folderNames) {
    const order = getSettings().folderOrder[book] ?? [];
    const out = [];
    for (const f of order) if (folderNames.has(f)) out.push(f);
    for (const f of [...folderNames].sort((a, b) => a.localeCompare(b))) if (!out.includes(f)) out.push(f);
    getSettings().folderOrder[book] = out;
    return out;
}

// ---------------------------------------------------------- binding model
// ST moved World Info settings inside the world-info.js module and REMOVED
// ctx.worldInfoSettings from the extension context. The module exports
// `world_info` (the settings object: charLore, globalSelect, …) and
// `selected_world_info` (the globally active books, read at prompt time) as
// LIVE ES-module bindings — a cached namespace import gives always-current
// synchronous access. updateWorldInfoSettings(settings, activeWorldInfo) is
// the canonical global-active write.
let wiModule; // undefined = unresolved, null = import failed
async function loadWiModule() {
    if (wiModule === undefined) {
        try { wiModule = await import('../../../world-info.js'); }
        catch { wiModule = null; }
    }
    return wiModule;
}
function wiLive() {
    return wiModule?.world_info ?? ctx.worldInfoSettings ?? null;
}

// Treat the returned array as read-only (it may be the live module array)
function globalActiveList() {
    if (Array.isArray(wiModule?.selected_world_info)) return wiModule.selected_world_info;
    const wiObj = wiLive();
    if (Array.isArray(wiObj?.globalSelect)) return wiObj.globalSelect;
    const v = jq('#world_info').val();
    return Array.isArray(v) ? v : [];
}

// Canonical global-active write. ST's `#world_info` change handler re-derives
// the active list from the select2-backed DOM — and when our synthetic jQuery
// `change` event reaches it, the value it reads back doesn't match what we
// set (select2's data layer knows nothing about programmatic changes), so it
// CLOBBERS the state the API call below just wrote — dropping the toggled
// book and displacing previously active ones. So: write state via the
// official API (ST PR #4921 added it for exactly this), sync the UI with the
// select2-namespaced event only, then re-assert the authoritative state.
async function setGlobalActiveList(list) {
    const wi = await loadWiModule();
    const apply = () => {
        if (typeof wi?.updateWorldInfoSettings === 'function' && typeof wi?.getWorldInfoSettings === 'function') {
            wi.updateWorldInfoSettings(wi.getWorldInfoSettings(), list);
        } else {
            // Legacy builds: mutate the settings object directly
            const wiObj = wiLive();
            if (wiObj) { wiObj.globalSelect = list; saveSettings(); }
        }
    };
    apply();

    const sel = jq('#world_info');
    if (sel.length) {
        for (const n of list) {
            if (![...sel[0].options].some((o) => o.value === n)) sel.append(new Option(n, n));
        }
        sel.val(list);
        // `change.select2` re-renders select2's tags but does NOT invoke
        // handlers bound to bare `change` — ST's own handler stays out of it.
        sel.trigger('change.select2');
    }

    // Re-assert: guarantee the authoritative state survived the UI sync
    if (Array.isArray(wiModule?.selected_world_info)
        && wiModule.selected_world_info.join('\u0000') !== list.join('\u0000')) {
        console.warn(`[${MODULE_NAME}] Global active list diverged during UI sync — re-applying`);
        apply();
    }
}

function findPersonaByBook(name) {
    const pu = ctx.powerUserSettings ?? {};
    return Object.keys(pu.persona_descriptions ?? {}).find(
        (k) => pu.persona_descriptions[k]?.lorebook === name,
    ) ?? null;
}

function primaryCharFor(name) {
    return (ctx.characters ?? []).find((c) => c?.data?.extensions?.world === name) ?? null;
}

function extraCharsFor(name) {
    return (wiLive()?.charLore ?? [])
        .filter((e) => Array.isArray(e?.extraBooks) && e.extraBooks.includes(name))
        .map((e) => e.name);
}

function computeBindings(name) {
    const out = new Set();
    if (globalActiveList().includes(name)) out.add('global');
    const pu = ctx.powerUserSettings ?? {};
    for (const d of Object.values(pu.persona_descriptions ?? {})) {
        if (d?.lorebook === name) { out.add('persona'); break; }
    }
    for (const ch of ctx.characters ?? []) {
        if (ch?.data?.extensions?.world === name) { out.add('character'); break; }
    }
    if (!out.has('character') && extraCharsFor(name).length) out.add('character');
    if (ctx.chatMetadata?.world_info === name) out.add('chat'); // current chat only
    // Chat binding: live (current chat) OR remembered from any other chat
    if (ctxNow().chatMetadata?.world_info === name || rememberedChatLinks(name).length) out.add('chat');
    return out;

}

// "Currently active" = would inject into the prompt right now: Global
// selection, the ACTIVE persona's lorebook (powerUserSettings.
// persona_description_lorebook — ST maintains it on persona switches; it is
// the same field ST's own /getpersona-book slash command reads), the current
// character's primary or additional lorebooks, or the current chat's live
// binding. Remembered links to OTHER chats don't count (they're not active).
function isCurrentlyActive(name, bindings) {
    if (bindings?.has('global')) return true;
    const c = ctxNow();
    const pu = ctx.powerUserSettings ?? {};
    if (pu.persona_description_lorebook === name) return true;
    const ch = c.characters?.[c.characterId];
    if (ch) {
        if (ch.data?.extensions?.world === name) return true;
        const key = String(ch.avatar).replace(/\.[^.]+$/, '');
        if ((wiLive()?.charLore ?? []).some((e) => e.name === key && e.extraBooks?.includes(name))) return true;
    }
    if (c.chatMetadata?.world_info === name) return true;
    return false;
}

const manualType = (name) => getSettings().types[name] ?? null;

// ---------------------------------------------------------- book info cache
function invalidateBooks(name) {
    cacheEpoch++; // any invalidation also invalidates the gallery render signature
    if (name) bookCache.delete(name); else bookCache.clear();
}

async function getBookInfo(name) {
    const hit = bookCache.get(name);
    if (hit) return hit;
    const info = { count: 0, chars: 0, folders: new Map(), uidFolder: new Map() };
    try {
        const data = await ctx.loadWorldInfo(name);
        for (const e of Object.values(data?.entries ?? {})) {
            info.count++;
            info.chars += String(e.content ?? '').length;
            const f = folderOf(e);
            info.uidFolder.set(e.uid, f);
            if (f) info.folders.set(f, (info.folders.get(f) ?? 0) + 1);
        }
    } catch { /* unreadable book */ }
    bookCache.set(name, info);
    return info;
}

// ---------------------------------------------------------- token counts
// Real tokenizer-based counts (entry.content only). ST caches counts by
// content hash in indexedDB, so recounts of unchanged text are near-free.
// The signature (count:chars) detects edits from anywhere; the tokenizer key
// invalidates on tokenizer/API/model changes.
const tokenCounts = new Map();   // bookName -> { key, sig, total, perEntry: Map<uid, number>, done, estimated }
const tokenInflight = new Set();

async function ensureBookTokens(name, entries) {
    if (!name || !entries) return null;
    const key = tokenizerKey();
    const sig = `${entries.length}:${entries.reduce((a, e) => a + String(e.content ?? '').length, 0)}`;
    const cached = tokenCounts.get(name);
    if (cached?.done && cached.key === key && cached.sig === sig) return cached;
    if (tokenInflight.has(name)) return cached ?? null;
    tokenInflight.add(name);
    try {
        const st = { key, sig, total: 0, perEntry: new Map(), done: false, estimated: false };
        for (const e of entries) {
            if (e?.uid === undefined) continue;
            const text = String(e.content ?? '');
            const n = await countTokens(text);
            if (n === null) {
                st.estimated = true;
                st.perEntry.set(e.uid, estTokens(text));
            } else {
                st.perEntry.set(e.uid, n);
            }
        }
        st.total = [...st.perEntry.values()].reduce((a, b) => a + b, 0);
        st.done = true;
        tokenCounts.set(name, st);
        return st;
    } finally {
        tokenInflight.delete(name);
    }
}

// Push finished counts into every visible surface (gallery cards, popup
// entry rows, sidebar stat) via in-place span updates — no re-render.
function applyBookTokens(name) {
    const st = tokenCounts.get(name);
    if (!st?.done) return;
    const tk = (n) => ` · ${tokenLabel(n, st.estimated)} tk`;
    $$('[data-wig-token]').forEach((el) => {
        if (el.dataset.wigToken === name) el.textContent = tk(st.total);
    });
    if (state.bp?.name === name && state.bp.dlg?.content) {
        const root = state.bp.dlg.content;
        $$('[data-wig-token-entry]', root).forEach((el) => {
            const n = st.perEntry.get(Number(el.dataset.wigTokenEntry));
            if (n !== undefined) el.textContent = tk(n);
        });
        const stat = $('[data-wig-stat-tokens]', root);
        if (stat) stat.textContent = `${tokenLabel(st.total, st.estimated)} tokens`;
    }
}

// Background pass over gallery books (sequential; skips up-to-date ones)
async function countGalleryTokens(names) {
    if (!getSettings().showTokens || !names?.length) return;
    const key = tokenizerKey();
    const pending = names.filter((n) => {
        const st = tokenCounts.get(n);
        if (!st || !st.done || st.key !== key) return true;
        const info = bookCache.get(n);
        return !info || st.sig !== `${info.count}:${info.chars}`;
    });
    for (const n of pending) {
        if (tokenInflight.has(n)) continue;
        try {
            const data = await ctx.loadWorldInfo(n);
            await ensureBookTokens(n, Object.values(data?.entries ?? {}));
        } catch { /* unreadable book */ }
        applyBookTokens(n);
    }
    // Token-based sort order may now be accurate — refresh once if relevant.
    if (pending.length && state.view === 'gallery' && state.sort === 'tokens-desc') renderGallery();
}

async function schedulePopupTokens(book, entries) {
    if (!getSettings().showTokens) return;
    const st = await ensureBookTokens(book, entries);
    if (st?.done) applyBookTokens(book);
}

// ---------------------------------------------------------- covers
function coverFor(name, bindings) {
    const s = getSettings();
    if (s.covers[name]) return { url: s.covers[name] };
    if (!s.deriveCovers) return null;
    try {
        if (bindings.has('character')) {
            const primary = primaryCharFor(name);
            if (primary?.avatar) return { url: safeThumb('avatar', primary.avatar) };
            // Auxiliary-only book: derive from a character that links it
            const key = extraCharsFor(name)[0];
            const extra = key && (ctx.characters ?? []).find(
                (c) => String(c.avatar ?? '').replace(/\.[^.]+$/, '') === key);
            if (extra?.avatar) return { url: safeThumb('avatar', extra.avatar) };
        }
        if (bindings.has('persona')) {
            const id = findPersonaByBook(name);
            if (id) return { url: safeThumb('persona', id) };
        }
        // Chat-bound book: derive from the character that OWNS the binding
        // chat — the remembered link's owner — not the current chat's
        // character, so the cover stays stable when chats are switched or
        // closed. Live binding → current chat's owner; otherwise the first
        // remembered link. Group-owned chats have no single character and
        // fall through to the placeholder.
        if (bindings.has('chat')) {
            const live = ctxNow();
            const boundHere = live.chatMetadata?.world_info === name;
            const owner = boundHere ? chatOwnerKey() : rememberedChatLinks(name)[0]?.o;
            const ch = owner && !String(owner).startsWith('group:')
                ? (ctx.characters ?? []).find((c) => c.avatar === owner)
                : null;
            if (ch?.avatar) return { url: safeThumb('avatar', ch.avatar) };
        }
    } catch { /* fall through */ }
    return null;
}

function resizeImage(file, maxW = 400, maxH = 560) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = url;
    });
}

async function uploadCover(worldName, dataUrl) {
    const b64 = dataUrl.split(',')[1] ?? dataUrl;
    const filename = `${MODULE_NAME}_${worldName}`.replace(/[^\w-]/g, '_').slice(0, 60);
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ image: b64, format: 'jpg', ch_name: MODULE_NAME, filename }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.path) throw new Error('No path returned');
    return `${data.path}?v=${Date.now()}`;
}

function pickCover(name) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const path = await uploadCover(name, await resizeImage(file));
            getSettings().covers[name] = path;
            saveSettings();
            renderGallery();
            if (state.bp?.name === name) renderPopupHead();
            toast('success', 'Cover updated.');
        } catch (e) {
            console.error(`[${MODULE_NAME}] cover upload failed`, e);
            toast('error', 'Cover upload failed.');
        }
    };
    input.click();
}

// ---------------------------------------------------------- view mode
function setView(mode) {
    state.view = mode;
    jq('#world_popup').toggleClass('wig-gallery-open', mode === 'gallery');
    if (mode === 'gallery') renderGallery();
    else { refreshFolderBar(); applyFolderFilter(); }
}

async function openBook(name) {
    const names = await ctx.getWorldInfoNames();
    const idx = names.indexOf(name);
    if (idx === -1) { toast('warning', `Lorebook "${name}" no longer exists.`); return; }
    jq('#world_editor_select').val(String(idx));
    setView('editor'); // explicit — the synthetic change below no longer flips views
    jq('#world_editor_select').trigger('change'); // ST loads the book into the editor
}

async function openNativeAt(name, uid) {
    if (!await closeBookPopup()) return; // drafts open — guard is asking; stay put
    await openBook(name);
    for (let i = 0; i < 15; i++) {
        const el = document.querySelector(`#world_popup_entries_list .world_entry[uid="${uid}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center' });
            el.classList.add('wig-flash');
            setTimeout(() => el.classList.remove('wig-flash'), 1600);
            return;
        }
        await sleep(100);
    }
}

// ---------------------------------------------------------- book file ops
// ST's WI server API was refactored: /api/worldinfo/create and /rename were
// REMOVED (only list/get/delete/import/edit remain), and /api/worldinfo/edit
// writes the file unconditionally — so it doubles as "create". All our book
// writes go through these helpers.

async function writeWorldFile(name, data) {
    const payload = (data && typeof data === 'object') ? { ...data, name } : { entries: {}, name };
    const res = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name, data: payload }),
    });
    if (!res.ok) throw new Error(`edit failed: HTTP ${res.status}`);
}

async function createWorldFile(name) {
    // 1) ST's own client routine (its slash commands call it with a bare name)
    try {
        const wi = await import('../../../world-info.js');
        if (typeof wi?.createNewWorldInfo === 'function') {
            await wi.createNewWorldInfo(name);
            return;
        }
    } catch { /* not exported — try endpoints */ }
    // 2) Legacy endpoint (older ST builds)
    try {
        const res = await fetch('/api/worldinfo/create', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (res.ok) return;
    } catch { /* fall through */ }
    // 3) Current ST: /edit creates the file
    await writeWorldFile(name, { entries: {} });
}

// Rewrites every binding that referenced the old name (the native rename
// flow offers the same). Returns the number of references updated.
async function relinkWorldReferences(oldName, newName) {
    let touched = 0;

    // Global selection — canonical write via the WI module API
    const curGlobal = globalActiveList();
    if (curGlobal.includes(oldName)) {
        await setGlobalActiveList(curGlobal.map((v) => (v === oldName ? newName : v)));
        touched++;
    }

    // Character primary books
    for (const ch of [...(ctx.characters ?? [])]) {
        if (ch?.data?.extensions?.world !== oldName) continue;
        ch.data.extensions.world = newName;
        touched++;
        try {
            if (typeof ctx.createOrEditCharacter === 'function') await ctx.createOrEditCharacter(ch, ch.avatar);
            else ctx.saveCharacterDebounced?.(ch);
        } catch (e) { console.warn(`[${MODULE_NAME}] character relink save failed`, e); }
    }

    // Character additional books (live settings object)
    await loadWiModule();
    for (const cl of wiLive()?.charLore ?? []) {
        if (Array.isArray(cl?.extraBooks) && cl.extraBooks.includes(oldName)) {
            cl.extraBooks = cl.extraBooks.map((b) => (b === oldName ? newName : b));
            touched++;
        }
    }

    // Persona lorebooks (+ the active-persona mirror)
    const pu = ctx.powerUserSettings ?? {};
    for (const d of Object.values(pu.persona_descriptions ?? {})) {
        if (d?.lorebook === oldName) { d.lorebook = newName; touched++; }
    }
    if (pu.persona_description_lorebook === oldName) pu.persona_description_lorebook = newName;

    // Current chat binding (live metadata — see ctxNow)
    const liveMeta = ctxNow().chatMetadata;
    if (liveMeta?.world_info === oldName) {
        liveMeta.world_info = newName;
        try { await ctx.saveMetadata(); } catch { /* non-fatal */ }
        jq('.chat_lorebook_button').addClass('world_set');
        touched++;
    }

    saveSettings();
    return touched;
}

async function createBook() {
    const input = await ctx.Popup.show.input('New lorebook name', '', '');
    const n = String(input ?? '').trim();
    if (!n) return;
    const before = await ctx.getWorldInfoNames();
    if (before.includes(n)) { toast('warning', 'A lorebook with that name already exists.'); return; }
    try {
        await createWorldFile(n);
    } catch (e) {
        console.error(`[${MODULE_NAME}] create failed`, e);
        toast('error', 'Could not create lorebook.');
        return;
    }
    await ctx.updateWorldInfoList?.();
    const names = (await ctx.getWorldInfoNames()) ?? [];
    state.lastNames = names;
    // Native creation may sanitize/adjust the name — open whatever appeared
    const actual = names.includes(n) ? n : (names.find((x) => !before.includes(x)) ?? n);
    onBooksChanged();
    openBookPopup(actual);
}

async function exportBook(name) {
    let exported = false;
    try {
        // Prefer ST's own export routine — identical output to the native editor's button
        const wi = await import('../../../world-info.js');
        if (typeof wi?.exportWorldInfo === 'function') {
            await wi.exportWorldInfo(name);
            exported = true;
        }
    } catch { /* fall through to a manual download */ }
    if (exported) return;
    try {
        const data = await ctx.loadWorldInfo(name);
        if (!data) { toast('error', 'Could not read the lorebook.'); return; }
        const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.replace(/[^\w-]/g, '_')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('success', `Exported "${name}".`);
    } catch (e) {
        console.error(`[${MODULE_NAME}] export failed`, e);
        toast('error', 'Export failed.');
    }
}

async function duplicateBook(name) {
    const input = await ctx.Popup.show.input('Duplicate lorebook', 'New name:', `${name} (copy)`);
    const newName = String(input ?? '').trim();
    if (!newName || newName === name) return;
    const names = await ctx.getWorldInfoNames();
    if (names.includes(newName)) { toast('warning', 'A lorebook with that name already exists.'); return; }

    const data = await ctx.loadWorldInfo(name);
    if (!data) { toast('error', 'Could not read the lorebook.'); return; }

    try {
        // Entry uids are kept as-is (uid spaces are per-book); folders travel
        // with the entries (entry.extensions.lorebook_folder).
        await writeWorldFile(newName, data);
    } catch (e) {
        console.error(`[${MODULE_NAME}] duplicate failed`, e);
        toast('error', 'Could not create the copy.');
        return;
    }

    const s = getSettings();
    if (s.covers[name]) s.covers[newName] = s.covers[name];
    if (s.folderOrder[name]) s.folderOrder[newName] = [...s.folderOrder[name]];
    if (s.collapsedFolders[name]) s.collapsedFolders[newName] = { ...s.collapsedFolders[name] };
    if (s.types[name]) s.types[newName] = s.types[name];
    s.lmImported[newName] = true;
    saveSettings();
    invalidateBooks(newName);

    await ctx.updateWorldInfoList?.();
    state.lastNames = (await ctx.getWorldInfoNames()) ?? [];
    onBooksChanged();
    toast('success', `Duplicated "${name}" as "${newName}".`);
    openBookPopup(newName);
}

function importBook() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;
    input.onchange = async () => {
        let imported = 0;
        for (const file of input.files ?? []) {
            try {
                const data = JSON.parse(await file.text());
                if (!data || typeof data !== 'object' || !data.entries) throw new Error('Not a lorebook file');
                // Older/external formats store entries as an array — normalize
                if (Array.isArray(data.entries)) {
                    data.entries = Object.fromEntries(data.entries.map((e, i) => [String(e?.uid ?? i), e]));
                }
                const base = String(data.name ?? file.name.replace(/\.json$/i, '')).trim() || 'Imported lorebook';
                const names = await ctx.getWorldInfoNames();
                let finalName = base;
                let n = 2;
                while (names.includes(finalName)) finalName = `${base} (${n++})`;
                names.push(finalName);
                await writeWorldFile(finalName, data);
                invalidateBooks(finalName);
                imported++;
                toast('success', `Imported "${finalName}".`);
            } catch (e) {
                console.error(`[${MODULE_NAME}] import failed`, file.name, e);
                toast('error', `Failed to import "${file.name}".`);
            }
        }
        if (imported) {
            await ctx.updateWorldInfoList?.();
            state.lastNames = (await ctx.getWorldInfoNames()) ?? [];
            onBooksChanged();
        }
    };
    input.click();
}

async function renameBook(oldName) {
    const input = await ctx.Popup.show.input('Rename lorebook', 'New name:', oldName);
    const newName = String(input ?? '').trim();
    if (!newName || newName === oldName) return;

    const names = await ctx.getWorldInfoNames();
    if (names.includes(newName)) { toast('warning', 'A lorebook with that name already exists.'); return; }

    const data = await ctx.loadWorldInfo(oldName);
    if (!data) { toast('error', 'Could not read the lorebook.'); return; }

    let legacy = false;
    try {
        const res = await fetch('/api/worldinfo/rename', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ name: oldName, newName }),
        });
        legacy = res.ok;
    } catch { legacy = false; }

    try {
        if (legacy) {
            // Older ST renamed server-side; rewrite once to sync the embedded name
            await writeWorldFile(newName, data);
        } else {
            // Current ST has no /rename: write under the new name (/edit creates
            // the file), then remove the old file via /delete.
            await writeWorldFile(newName, data);
            const del = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ name: oldName }),
            });
            if (!del.ok) throw new Error(`delete failed: HTTP ${del.status}`);
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] rename failed`, e);
        toast('error', 'Rename failed.');
        return;
    }

    // Keep bindings working — relink everything that referenced the old name
    let relinked = 0;
    try {
        relinked = await relinkWorldReferences(oldName, newName);
    } catch (e) { console.warn(`[${MODULE_NAME}] relink failed`, e); }

    const s = getSettings();
    s.covers[newName] = s.covers[oldName] ?? s.covers[newName]; delete s.covers[oldName];
    s.types[newName] = s.types[oldName] ?? s.types[newName]; delete s.types[oldName];
    s.folderOrder[newName] = s.folderOrder[oldName] ?? []; delete s.folderOrder[oldName];
    s.collapsedFolders[newName] = s.collapsedFolders[oldName] ?? {}; delete s.collapsedFolders[oldName];
    s.lmImported[newName] = s.lmImported[oldName] ?? true; delete s.lmImported[oldName];
    if (s.chatBindings[oldName]) { s.chatBindings[newName] = s.chatBindings[oldName]; delete s.chatBindings[oldName]; }
    saveSettings();
    invalidateBooks(oldName);
    invalidateBooks(newName);

    await ctx.updateWorldInfoList?.();
    state.lastNames = (await ctx.getWorldInfoNames()) ?? [];
    if (state.bp?.name === oldName) {
        state.bp.name = newName;
        renderPopupHead();
        renderPopupEntriesPage(); // rebuild closures that captured the old name
    }
    onBooksChanged();
    toast('success', `Renamed to "${newName}"${relinked ? ` — ${relinked} binding${relinked === 1 ? '' : 's'} relinked` : ''}.`);
}

async function deleteBook(name) {
    const ok = await ctx.Popup.show.confirm(`Delete "${name}"?`, 'This permanently deletes the lorebook file.');
    if (!ok) return;
    const res = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!res.ok) { toast('error', 'Delete failed.'); return; }
    const s = getSettings();
    delete s.covers[name];
    delete s.types[name];
    delete s.folderOrder[name];
    delete s.collapsedFolders[name];
    delete s.lmImported[name];
    delete state.folderFilter[name];
	delete s.chatBindings[name];
    saveSettings();
    invalidateBooks(name);
    if (state.bp?.name === name) await closeBookPopup(true);
    ctx.updateWorldInfoList?.();
    await onBooksChanged();
    toast('success', `"${name}" deleted.`);
}

// ---------------------------------------------------------- binding actions
// Re-renders every surface that shows bindings after an action changes them —
// including the popup's Settings tab, whose rows are render-time snapshots.
function refreshPopupBindingUi(name) {
    renderGallery();
    if (state.bp?.name === name) {
        renderPopupHead();
        if (state.bp.tab === 'settings') renderPopupSettingsPage();
    }
}

async function assignPersona(avatarId, name, remove = false) {
    const pu = ctx.powerUserSettings;
    const d = pu.persona_descriptions[avatarId] ??= {
        description: '', position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: '',
    };
    d.lorebook = remove ? '' : name;
    const current = ctxNow().chatMetadata?.persona ?? pu.default_persona
        ?? (Object.keys(pu.personas ?? {}).length === 1 ? avatarId : null);
    if (current === avatarId) pu.persona_description_lorebook = d.lorebook;
    saveSettings();
    toast('success', remove ? 'Unbound from persona.' : 'Bound to persona.');
    refreshPopupBindingUi(name);
}

async function assignCharacter(ch, name, kind, remove = false) {
    if (kind === 'primary') {
        ch.data.extensions.world = remove ? '' : name;
        try {
            if (typeof ctx.createOrEditCharacter === 'function') await ctx.createOrEditCharacter(ch, ch.avatar);
            else ctx.saveCharacterDebounced?.(ch);
        } catch (e) { console.warn(`[${MODULE_NAME}] character save failed`, e); }
    } else {
        await loadWiModule();
        const wiObj = wiLive();
        if (!wiObj) { toast('error', 'World Info settings are unavailable on this build.'); return; }
        const key = String(ch.avatar).replace(/\.[^.]+$/, '');
        const arr = (wiObj.charLore ??= []);
        let entry = arr.find((e) => e.name === key);
        if (!entry) { entry = { name: key, extraBooks: [] }; arr.push(entry); }
        entry.extraBooks ??= [];
        if (remove) entry.extraBooks = entry.extraBooks.filter((b) => b !== name);
        else if (!entry.extraBooks.includes(name)) entry.extraBooks.push(name);
        saveSettings(); // persists: script.js saves world_info_settings from the live object
    }
    toast('success', 'Character lore updated.');
    refreshPopupBindingUi(name);
}

async function assignChat(name, remove = false) {
    if (!chatOpen()) { toast('warning', 'Open a chat first.'); return; }
    const meta = ctxNow().chatMetadata; // live object — writes reach the real chat file
    if (remove) delete meta?.world_info;
    else meta.world_info = name;
    await ctx.saveMetadata(); // function reads live state internally — safe on the cached ctx
    jq('.chat_lorebook_button').toggleClass('world_set', !remove);
    noteChatBindings(); // remember (or forget) this chat's link right away
    refreshPopupBindingUi(name);
}

async function setGlobalActive(name, active) {
    const cur = globalActiveList();
    const next = active
        ? [...new Set([...cur, name])]
        : cur.filter((x) => x !== name);
    await setGlobalActiveList(next);
    refreshPopupBindingUi(name);
}

function setType(name, t) {
    const s = getSettings();
    if (t) s.types[name] = t; else delete s.types[name];
    saveSettings();
    refreshPopupBindingUi(name);
}

// ---------------------------------------------------------- floating menu
let wigMenu = null;
function onMenuEsc(e) { if (e.key === 'Escape') closeMenu(); }
function closeMenu() {
    wigMenu?.remove();
    wigMenu = null;
    document.removeEventListener('keydown', onMenuEsc);
}
function onOutsideMenu(e) {
    if (wigMenu && !wigMenu.contains(e.target)) closeMenu();
    else if (wigMenu) document.addEventListener('pointerdown', onOutsideMenu, { capture: true, once: true });
}
function showMenu(items, anchor) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'wig-menu';
    for (const it of items) {
        if (it?.type === 'divider') {
            const d = document.createElement('div');
            d.className = 'wig-menu-divider';
            menu.appendChild(d);
            continue;
        }
        if (it?.type === 'search') {
            const box = document.createElement('input');
            box.type = 'text';
            box.className = 'text_pole wig-menu-search';
            box.placeholder = it.placeholder ?? 'Filter…';
            box.autocomplete = 'off';
            const applyFilter = () => {
                const q = box.value.trim().toLowerCase();
                for (const r of menu.querySelectorAll('.wig-menu-item, .wig-menu-divider')) {
                    if (r.classList.contains('wig-menu-divider')) { r.style.display = q ? 'none' : ''; continue; }
                    if (!r.dataset.wigSearch) continue; // pinned rows stay visible
                    r.style.display = (!q || r.dataset.wigSearch.includes(q)) ? '' : 'none';
                }
            };
            box.addEventListener('input', applyFilter);
            box.addEventListener('keydown', (ev) => {
                ev.stopPropagation(); // typing must not close the menu
                if (ev.key === 'Escape') { box.value = ''; applyFilter(); }
            });
            menu.appendChild(box);
            setTimeout(() => box.focus(), 0);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'wig-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
        if (it.title) row.title = it.title;
        if (!it.pinned) row.dataset.wigSearch = String(it.label ?? '').toLowerCase();
        if (it.img) {
            const im = document.createElement('img');
            im.className = 'wig-menu-img';
            im.src = it.img;
            im.onerror = () => im.remove();
            row.appendChild(im);
        } else {
            const ic = document.createElement('i');
            ic.className = 'fa-solid ' + (it.icon || 'fa-circle-dot');
            row.appendChild(ic);
        }
        const label = document.createElement('span');
        label.textContent = it.label;
        row.appendChild(label);
        if (!it.disabled) row.addEventListener('click', () => { closeMenu(); it.action?.(row); });
        menu.appendChild(row);
    }
    const host = menuHost(anchor);
    host.appendChild(menu);
    wigMenu = menu;

    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x, y;

    if (host === document.body) {
        menu.style.position = 'fixed';
        x = Math.max(8, Math.min((r.left ?? 8), window.innerWidth - mw - 8));
        y = (r.bottom ?? 0) + 4;
        if (y + mh > window.innerHeight - 8) y = Math.max(8, (r.top ?? 0) - mh - 4);
    } else {
        // Host is an open <dialog> or the World Info panel. Theme skins
        // (Moonlit Echoes) and PTMT transform their containers, which makes
        // position:fixed resolve against the host's box instead of the
        // viewport — so anchor absolutely to the host's on-screen box. The
        // rect math is transform-proof (getBoundingClientRect() is
        // post-transform) and stays correct under scrolling, since the host
        // and the anchor move together.
        menu.style.position = 'absolute';
        const hr = host.getBoundingClientRect();
        const pad = 8;
        // Visible region: the host's box clipped by its first scrolling
        // ancestor (the drawer content scrolls on desktop) and by the
        // viewport — keeps the menu on screen when the host is taller than
        // the visible panel.
        let vl = hr.left, vt = hr.top, vr = hr.right, vb = hr.bottom;
        for (let p = host.parentElement; p && p !== document.documentElement; p = p.parentElement) {
            if (['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) {
                const pr = p.getBoundingClientRect();
                vl = Math.max(vl, pr.left); vt = Math.max(vt, pr.top);
                vr = Math.min(vr, pr.right); vb = Math.min(vb, pr.bottom);
                break;
            }
        }
        vl = Math.max(vl, 0); vt = Math.max(vt, 0);
        vr = Math.min(vr, window.innerWidth); vb = Math.min(vb, window.innerHeight);
        // Desired viewport position, clamped into the visible region
        let vx = r.left ?? hr.left;
        let vy = (r.bottom ?? 0) + 4;
        if (vy + mh > vb - pad) vy = Math.max(vt + pad, (r.top ?? 0) - mh - 4);
        vx = Math.max(vl + pad, Math.min(vx, vr - mw - pad));
        if (vy < vt + pad) vy = vt + pad;
        // Viewport → host coordinates. When the host itself scrolls (mobile
        // layouts give #world_popup overflow-y: auto), absolute children
        // position in the scrolled content space.
        const hostScrolls = ['auto', 'scroll'].includes(getComputedStyle(host).overflowY);
        x = vx - hr.left + (hostScrolls ? host.scrollLeft : 0);
        y = vy - hr.top + (hostScrolls ? host.scrollTop : 0);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    document.addEventListener('keydown', onMenuEsc);
    setTimeout(() => document.addEventListener('pointerdown', onOutsideMenu, { capture: true, once: true }), 0);
}

function menuHost(anchor) {
    // Mirrors ST's getTopmostModalLayer(): popups are native <dialog> elements
    // in the browser's top layer, so nothing appended to <body> can render
    // above one. When a dialog is open, mount the menu inside it.
    const dialogs = $$('dialog[open]:not([closing])');
    if (dialogs.length) return dialogs[dialogs.length - 1];
    // Menus anchored inside the World Info panel mount INSIDE it. ST closes
    // drawers on clicks "outside" them, and the check is DOM containment
    // against a whitelist of selectors — '#world_popup' is one of them
    // (script.js ~12105, alongside '.popup' and '.ui-widget'). A <body>-
    // mounted menu matches nothing on that list however it's painted, so
    // every click on it dismissed the WI drawer behind it (invisible under
    // PTMT, whose tabs never auto-close). Inside #world_popup, the menu is
    // part of the panel and the drawer stays open.
    if (anchor instanceof Element) {
        const wp = document.getElementById('world_popup');
        if (wp?.contains(anchor)) return wp;
    }
    return document.body;
}

// ---------------------------------------------------------- card menus
function cardMenu(name, anchor) {
    const bindings = computeBindings(name);
    const hasCover = !!getSettings().covers[name];
    showMenu([
        { icon: 'fa-window-maximize', label: 'Open details', action: () => openBookPopup(name) },
        { icon: 'fa-book-open', label: 'Open in native editor', action: () => openBook(name) },
        { type: 'divider' },
        { icon: 'fa-image', label: 'Set cover image…', action: () => pickCover(name) },
        { icon: 'fa-eraser', label: 'Remove cover', disabled: !hasCover, action: () => { delete getSettings().covers[name]; saveSettings(); renderGallery(); } },
        { type: 'divider' },
        { icon: 'fa-user', label: 'Link to persona…', action: () => menuAssignPersona(name, anchor) },
        { icon: 'fa-user-astronaut', label: 'Link to character…', action: () => menuAssignCharacter(name, anchor) },
        { icon: 'fa-comments', label: 'Link to current chat', disabled: !chatOpen(), action: () => assignChat(name) },
        { icon: 'fa-unlink', label: 'Unlink from current chat', disabled: !(chatOpen() && ctxNow().chatMetadata?.world_info === name), action: () => assignChat(name, true) },
        { icon: 'fa-eraser', label: 'Forget chat links', disabled: !rememberedChatLinks(name).length, action: () => forgetChatBindings(name) },
        { icon: 'fa-globe', label: bindings.has('global') ? 'Remove from Global' : 'Add to Global', action: () => setGlobalActive(name, !bindings.has('global')) },
        { icon: 'fa-tag', label: 'Manual type label…', action: () => menuSetType(name, anchor) },
        { icon: 'fa-i-cursor', label: 'Rename…', action: () => renameBook(name) },
        { icon: 'fa-clone', label: 'Duplicate lorebook…', action: () => duplicateBook(name) },
        { icon: 'fa-file-export', label: 'Export lorebook', action: () => exportBook(name) },
        { type: 'divider' },
        { icon: 'fa-trash-can', label: 'Delete lorebook', danger: true, action: () => deleteBook(name) },
    ], anchor);
}

function menuAssignPersona(name, anchor) {
    const pu = ctx.powerUserSettings ?? {};
    const personas = Object.entries(pu.personas ?? {});
    if (!personas.length) { toast('warning', 'No personas found.'); return; }
    const bound = findPersonaByBook(name);
    const items = personas.map(([avatarId, pname]) => ({
        icon: avatarId === bound ? 'fa-check' : 'fa-user',
        label: pname || avatarId,
        img: safeThumb('persona', avatarId),
        action: () => assignPersona(avatarId, name),
    }));
	if (personas.length > 12) items.unshift({ type: 'search', placeholder: 'Filter personas…' });
    items.push({ type: 'divider' });
    items.push({ icon: 'fa-xmark', label: 'Unbind from persona', danger: true, disabled: !bound, action: () => bound && assignPersona(bound, name, true) });
    showMenu(items, anchor);
}

function menuAssignCharacter(name, anchor) {
    const chars = ctx.characters ?? [];
    if (!chars.length) { toast('warning', 'No characters found.'); return; }
    const items = [];
    // Pin the current chat's character at the top — the common case — so it
    // never requires scrolling or searching the list.
    const current = ctxNow().characters?.[ctxNow().characterId] ?? null;
    if (current) {
        items.push({
            icon: current === primaryCharFor(name) ? 'fa-check' : 'fa-user-astronaut',
            label: `Current: ${current.name}`,
            img: safeThumb('avatar', current.avatar),
            title: 'The character of the chat you have open',
            pinned: true,
            action: () => menuCharacterActions(name, current, anchor),
        });
        items.push({ type: 'divider' });
    }
    items.push({ type: 'search', placeholder: 'Filter characters…' });
    for (const ch of chars.slice(0, 300)) {
        items.push({
            icon: ch === primaryCharFor(name) ? 'fa-check' : 'fa-user-astronaut',
            label: ch.name,
            img: safeThumb('avatar', ch.avatar),
            action: () => menuCharacterActions(name, ch, anchor),
        });
    }
    showMenu(items, anchor);
}

function menuCharacterActions(name, ch, anchor) {
    const key = String(ch.avatar).replace(/\.[^.]+$/, '');
    const isPrimary = ch?.data?.extensions?.world === name;
    const isExtra = (wiLive()?.charLore ?? []).some((e) => e.name === key && e.extraBooks?.includes(name));
    showMenu([
        { icon: 'fa-book-bookmark', label: 'Set as primary lorebook', disabled: isPrimary, action: () => assignCharacter(ch, name, 'primary') },
        { icon: 'fa-circle-plus', label: 'Add as additional lorebook', disabled: isExtra, action: () => assignCharacter(ch, name, 'extra') },
        { type: 'divider' },
        { icon: 'fa-xmark', label: 'Remove primary binding', danger: true, disabled: !isPrimary, action: () => assignCharacter(ch, name, 'primary', true) },
        { icon: 'fa-xmark', label: 'Remove additional binding', danger: true, disabled: !isExtra, action: () => assignCharacter(ch, name, 'extra', true) },
    ], anchor);
}

function menuSetType(name, anchor) {
    showMenu([
        { icon: 'fa-user', label: 'Persona', action: () => setType(name, 'persona') },
        { icon: 'fa-user-astronaut', label: 'Character', action: () => setType(name, 'character') },
        { icon: 'fa-comments', label: 'Chat', action: () => setType(name, 'chat') },
        { type: 'divider' },
        { icon: 'fa-xmark', label: 'Clear label', danger: true, disabled: !manualType(name), action: () => setType(name, null) },
    ], anchor);
}

// ---------------------------------------------------------- gallery render
function addCoverIcon(cover) {
    const i = document.createElement('i');
    i.className = 'fa-solid fa-book wig-cover-icon';
    cover.appendChild(i);
}

function buildCard(c) {
    const el = document.createElement('div');
    el.className = 'wig-card';
    el.title = c.name + (c.chatLinks ? `\nChat-linked in ${c.chatLinks} chat${c.chatLinks === 1 ? '' : 's'}` : '');

    const cover = document.createElement('div');
    cover.className = 'wig-cover';
    cover.style.setProperty('--wig-hue', String(hueFromString(c.name)));
    const cov = coverFor(c.name, new Set(c.bindings));
    if (cov) {
        const im = document.createElement('img');
        im.loading = 'lazy';
        im.src = cov.url;
        im.onerror = () => { im.remove(); addCoverPlaceholder(cover, c.name); };
        cover.appendChild(im);
    } else addCoverPlaceholder(cover, c.name);

    const badges = document.createElement('div');
    badges.className = 'wig-badges';
    for (const b of c.bindings) {
        const s = document.createElement('span');
        s.className = `wig-badge wig-badge-${b}`;
        s.textContent = b;
        badges.appendChild(s);
    }
    if (c.manual && !c.bindings.includes(c.manual)) {
        const s = document.createElement('span');
        s.className = 'wig-badge wig-badge-manual';
        s.textContent = `${c.manual} ✎`;
        s.title = 'Manual label (not a live binding)';
        badges.appendChild(s);
    }
    if (badges.childElementCount) cover.appendChild(badges);

    const menuBtn = document.createElement('div');
    menuBtn.className = 'wig-card-menu fa-solid fa-ellipsis-vertical';
    menuBtn.title = 'Options';
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); cardMenu(c.name, menuBtn); });

    const title = document.createElement('div');
    title.className = 'wig-title';
    title.textContent = c.name;

    const meta = document.createElement('div');
    meta.className = 'wig-meta';
    const entSpan = document.createElement('span');
    entSpan.textContent = `${c.count} ${c.count === 1 ? 'entry' : 'entries'}`;
    meta.appendChild(entSpan);
    if (getSettings().showTokens) {
        const st = tokenCounts.get(c.name);
        const tokSpan = document.createElement('span');
        tokSpan.dataset.wigToken = c.name;
        tokSpan.textContent = ` · ${st?.done ? tokenLabel(st.total, st.estimated) : '…'} tk`;
        meta.appendChild(tokSpan);
    }

    el.append(cover, title, meta, menuBtn);
    el.addEventListener('click', () => openBookPopup(c.name));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); cardMenu(c.name, el); });
    return el;
}

function buildNewCard() {
    const el = document.createElement('div');
    el.className = 'wig-card wig-new';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-plus wig-new-icon';
    const label = document.createElement('div');
    label.className = 'wig-new-label';
    label.textContent = 'New lorebook';
    el.append(icon, label);
    el.addEventListener('click', () => createBook());
    return el;
}

function renderChips(cards) {
    const wrap = document.getElementById('wig-chips');
    if (!wrap) return;
    const counts = { all: cards.length, current: 0, unbound: 0, persona: 0, character: 0, chat: 0, global: 0 };
    for (const c of cards) {
        if (c.current) counts.current++;
        if (!c.bindings.length && !c.manual) counts.unbound++;
        for (const b of c.bindings) if (counts[b] !== undefined) counts[b]++;
        if (c.manual && counts[c.manual] !== undefined && !c.bindings.includes(c.manual)) counts[c.manual]++;
    }
    wrap.replaceChildren();
    for (const [key, label, icon] of FILTERS) {
        const chip = document.createElement('div');
        chip.className = 'wig-chip' + (state.filter === key ? ' active' : '');
        const i = document.createElement('i');
        i.className = 'fa-solid ' + icon;
        const t = document.createElement('span');
        t.textContent = `${label} (${counts[key] ?? 0})`;
        chip.append(i, t);
        if (key === 'current') chip.title = 'Active in the prompt right now: Global, current persona, current character, or current chat';
        chip.addEventListener('click', () => { state.filter = key; renderGallery(); });
        wrap.appendChild(chip);
    }
}

async function renderGallery() {
    const grid = document.getElementById('wig-grid');
    if (!grid) return;
    const seq = ++renderSeq;
    let names = [];
    try { names = (await ctx.getWorldInfoNames()) ?? []; } catch { /* keep previous */ }
    if (seq !== renderSeq) return;
    state.lastNames = names;

    // ---- No-op guard: rebuild the DOM only when something visible changed.
    // The gallery used to rebuild on EVERY trigger — including the frequent
    // SETTINGS_UPDATED events some extensions emit — destroying and
    // recreating every card under the cursor: hover transitions restarted
    // ("pulsing" highlights), lazy cover images were re-created, and async
    // token labels flipped widths, destabilizing scroll.
    const s = getSettings();
    const sigParts = names.map((n) => {
        const b = computeBindings(n);
        const st = tokenCounts.get(n);
        return [n, [...b].sort().join(','), s.covers[n] ?? '', manualType(n) ?? '',
            isCurrentlyActive(n, b) ? 1 : 0, rememberedChatLinks(n).length,
            st?.done ? st.total : '?'].join('\u0001');
    });
    const sig = [state.filter, state.search, state.sort, cacheEpoch,
        s.showTokens ? 1 : 0, s.deriveCovers ? 1 : 0, s.placeholderCover,
        sigParts.join('\u0002')].join('\u0000');
    const uiKey = [state.filter, state.search, state.sort].join('\u0000');
    if (sig === lastGallerySig && grid.childElementCount) return;

    // Preserve scroll across data-driven refreshes; a fresh search/filter/
    // sort should land at the top as usual.
    const scroller = scrollParentOf(grid);
    const keepScroll = (scroller && uiKey === lastGalleryUi) ? scroller.scrollTop : null;

    const cards = [];
    for (const name of names) {
        const bindings = computeBindings(name);
        const info = await getBookInfo(name);
        if (seq !== renderSeq) return;
        const st = tokenCounts.get(name);
        cards.push({
            name,
            bindings: [...bindings],
            manual: manualType(name),
            count: info.count,
            tokens: st?.done ? st.total : estTokensFromLength(info.chars),
            chatLinks: rememberedChatLinks(name).length,
            current: isCurrentlyActive(name, bindings),
        });
    }

    const q = state.search.toLowerCase();
    const list = cards.filter((c) =>
        (!q || c.name.toLowerCase().includes(q)) &&
        (state.filter === 'all' ? true :
         state.filter === 'current' ? c.current :
         state.filter === 'unbound' ? (c.bindings.length === 0 && !c.manual) :
         (c.bindings.includes(state.filter) || c.manual === state.filter)));

    const sorters = {
        'name-asc': (a, b) => a.name.localeCompare(b.name),
        'name-desc': (a, b) => b.name.localeCompare(a.name),
        'entries-desc': (a, b) => b.count - a.count || a.name.localeCompare(b.name),
        'tokens-desc': (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name),
    };
    list.sort(sorters[state.sort] ?? sorters['name-asc']);

    renderChips(cards);
    grid.replaceChildren(...list.map(buildCard), buildNewCard());
    if (keepScroll !== null && scroller) scroller.scrollTop = keepScroll;
    lastGallerySig = sig;
    lastGalleryUi = uiKey;
    const count = document.getElementById('wig-count');
    countGalleryTokens(names); // fire-and-forget real-token pass
    if (count) count.textContent = `${list.length} / ${cards.length}`;
}

// ---------------------------------------------------------- entry templates
// Prefer ST's own factory via dynamic import (same technique Lorebook
// Manager uses); fall back to a comprehensive template on failure.
const FALLBACK_ENTRY_TEMPLATE = {
    key: [], keysecondary: [], comment: 'New Entry', content: '',
    constant: false, selective: true, selectiveLogic: 0, addMemo: true,
    order: 100, position: 0, disable: false, excludeRecursion: false,
    preventRecursion: false, delayUntilRecursion: false, probability: 100,
    useProbability: true, depth: 4, group: '', groupOverride: false,
    groupWeight: 100, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '',
    role: 0, vectorized: false, sticky: 0, cooldown: 0, delay: 0,
};

async function makeNewEntry(data) {
    const uids = Object.values(data.entries ?? {}).map((e) => Number(e.uid)).filter(Number.isFinite);
    const nextUid = (uids.length ? Math.max(...uids) : -1) + 1;
    const nextDisplay = (Object.keys(data.entries ?? {}).length);
    let entry = null;
    try {
        const wi = await import('../../../world-info.js');
        if (typeof wi?.createWorldInfoEntry === 'function') {
            entry = wi.createWorldInfoEntry(null, data);
        }
    } catch { /* dynamic import unavailable */ }
    if (!entry) {
        entry = structuredClone(FALLBACK_ENTRY_TEMPLATE);
    }
    entry.uid = nextUid;
    entry.displayIndex ??= nextDisplay;
    entry.comment = 'New Entry';
    return entry;
}

const parseKeys = (value) => String(value ?? '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

const entryTitle = (e) => e.comment?.trim() || (e.key?.length ? e.key.join(', ') : `Entry ${e.uid}`);

// ---------------------------------------------------------- LM import
// Overlays Lorebook Manager's per-uid folder map (and our legacy wig_folder)
// onto the portable entry.extensions.lorebook_folder field, and adopts LM's
// folder order + collapse state. Saves only when something changed.
async function importFolderData(book) {
    const lm = lmWorldState(book);
    const data = await ctx.loadWorldInfo(book);
    if (!data?.entries) return 0;
    const names = new Set();
    let changed = 0;

    for (const e of Object.values(data.entries)) {
        if (e?.uid === undefined) continue;
        let folder = null;
        if (lm && Object.hasOwn(lm.entries ?? {}, String(e.uid))) {
            folder = String(lm.entries[String(e.uid)] ?? '').trim() || null;
        }
        if (!folder) {
            const ext = String(e.extensions?.[LM_FOLDER_FIELD] ?? '').trim();
            const legacy = String(e[LEGACY_FOLDER_FIELD] ?? '').trim();
            folder = ext || legacy || null;
        }
        if (folder === '__uncategorized__' || RESERVED.has(folder?.toLowerCase() ?? '')) folder = null;
        if (folder) names.add(folder);
        if (folderOf(e) !== folder || Object.hasOwn(e, LEGACY_FOLDER_FIELD)) {
            setEntryFolderField(e, folder);
            changed++;
        }
    }

    const s = getSettings();
    const order = s.folderOrder[book] ?? [];
    for (const f of (lm?.folders ?? []).map((x) => x.name)) if (!order.includes(f)) order.push(f);
    s.folderOrder[book] = order;
    if (lm?.collapsed && typeof lm.collapsed === 'object') {
        const c = s.collapsedFolders[book] ??= {};
        for (const [f, v] of Object.entries(lm.collapsed)) if (f in c === false && v) c[f] = true;
    }
    if (changed) {
        await ctx.saveWorldInfo(book, data);
        invalidateBooks(book);
        saveSettings();
    } else {
        saveSettings();
    }
    return changed;
}

// Closes the book popup. Returns true if it closed (or none was open),
// false when the unsaved-changes guard kept it open. `force` bypasses the
// guard — used when the book is being deleted or no longer exists, where
// drafts are meaningless.
async function closeBookPopup(force = false) {
    const bp = state.bp;
    if (!bp?.dlg) { state.bp = null; return true; }
    if (force) bp.forceClose = true;
    try {
        // complete() resolves undefined exactly when onClosing blocked it
        const outcome = await bp.dlg.completeCancelled();
        if (outcome === undefined && state.bp === bp) return false;
    } catch { /* already closed */ }
    return true;
}

async function openBookPopup(name) {
    const names = await ctx.getWorldInfoNames();
    if (!names.includes(name)) { toast('warning', `Lorebook "${name}" no longer exists.`); return; }
    if (state.bp && !await closeBookPopup()) return; // drafts kept open — stay put

    // One-time Lorebook Manager import, then always sweep legacy fields.
    const s = getSettings();
    if (!s.lmImported[name] && lmWorldState(name)) {
        const changed = await importFolderData(name);
        s.lmImported[name] = true;
        saveSettings();
        if (changed) toast('info', `Imported folders from Lorebook Manager (${changed} entries updated).`);
    } else {
        await importFolderData(name);
    }

    const root = document.createElement('div');
    root.className = 'wig-bp';

    state.bp = {
        name,
        dlg: null,
        tab: 'entries',
        filter: '',
        sort: 'default',
        expanded: new Set(),
        draggingUid: null,
        draggingFolder: null,
        drafts: new Set(),     // uids with unsaved edits (drives the guard)
        stash: new Map(),      // uid -> harvested editor values (survives rebuilds)
        forceClose: false,
    };

	const dlg = new ctx.Popup(root, POPUP_TEXT, '', {
		okButton: 'Close',
		cancelButton: false,
		wide: true,
		large: true,
		allowVerticalScrolling: false,
		// Unsaved-changes guard. ST awaits this handler inside complete(),
		// so we can confirm right here: false keeps the popup open.
		onClosing: async () => {
			const bp = state.bp;
			if (!bp || bp.forceClose || !bp.drafts?.size) return true;
			const n = bp.drafts.size;
			const ok = await ctx.Popup.show.confirm(
				'Discard unsaved changes?',
				`${n} ${n === 1 ? 'entry has' : 'entries have'} unsaved edits in "${bp.name}".`,
			);
			return !!ok; // Yes → close; No/Esc → keep editing
		},
	});
    state.bp.dlg = dlg;
    dlg.show().then(() => { if (state.bp?.dlg === dlg) state.bp = null; });

    root.innerHTML = `
        <div class="wig-bp-body">
            <aside class="wig-bp-side">
                <div class="wig-bp-head"></div>
            </aside>
            <div class="wig-bp-main">
                <div class="wig-bp-tabs">
                    <div class="wig-bp-tab active" data-tab="entries"><i class="fa-solid fa-list"></i> Entries</div>
                    <div class="wig-bp-tab" data-tab="settings"><i class="fa-solid fa-gear"></i> Settings</div>
                </div>
                <div class="wig-bp-page wig-bp-page-entries"></div>
                <div class="wig-bp-page wig-bp-page-settings" style="display:none"></div>
            </div>
        </div>`;

    $$('.wig-bp-tab', root).forEach((t) => t.addEventListener('click', () => {
        state.bp.tab = t.dataset.tab;
        $$('.wig-bp-tab', root).forEach((x) => x.classList.toggle('active', x === t));
        $('.wig-bp-page-entries', root).style.display = state.bp.tab === 'entries' ? '' : 'none';
        $('.wig-bp-page-settings', root).style.display = state.bp.tab === 'settings' ? '' : 'none';
        if (state.bp.tab === 'settings') renderPopupSettingsPage();
    }));

    renderPopupHead();
    renderPopupEntriesPage();
}

function renderPopupHead() {
    const bp = state.bp;
    const head = bp ? $('.wig-bp-head', bp.dlg?.content ?? document) : null;
    if (!bp || !head) return;
    const name = bp.name;
    const bindings = computeBindings(name);
    const info = bookCache.get(name);
    const manual = manualType(name);
    const cov = coverFor(name, bindings);

    head.replaceChildren();
    const cover = document.createElement('div');
    cover.className = 'wig-bp-cover';
    cover.style.setProperty('--wig-hue', String(hueFromString(name)));
    if (cov) {
        const im = document.createElement('img');
        im.src = cov.url;
        im.onerror = () => { im.remove(); addCoverPlaceholder(cover, name); };
        cover.appendChild(im);
    } else addCoverPlaceholder(cover, name);
    const cam = document.createElement('i');
    cam.className = 'fa-solid fa-camera wig-bp-cover-cam';
    cam.title = 'Change cover';
    cover.appendChild(cam);
    cover.addEventListener('click', () => pickCover(name));

    const infoBox = document.createElement('div');
    infoBox.className = 'wig-bp-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'wig-bp-name-row';
    const title = document.createElement('input');
    title.className = 'wig-bp-name text_pole';
    title.value = name;
    title.title = 'Click to rename';
    title.readOnly = true;
    title.addEventListener('click', () => { title.readOnly = false; title.select(); });
    title.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
        if (e.key === 'Escape') { title.value = state.bp.name; title.readOnly = true; title.blur(); }
    });
    title.addEventListener('blur', () => {
        const v = title.value.trim();
        title.readOnly = true;
        if (v && v !== state.bp.name) renameBook(state.bp.name).then(() => {
            const t = $('.wig-bp-name'); if (t) t.value = state.bp.name;
        });
        else title.value = state.bp.name;
    });
    const edit = document.createElement('i');
    edit.className = 'fa-solid fa-pencil wig-bp-name-edit';
    edit.title = 'Rename';
    edit.addEventListener('click', () => { title.readOnly = false; title.focus(); title.select(); });
    nameRow.append(title, edit);

    const stats = document.createElement('div');
    stats.className = 'wig-bp-stats';
    if (info) {
        const s1 = document.createElement('span');
        s1.textContent = `${info.count} ${info.count === 1 ? 'entry' : 'entries'}`;
        stats.appendChild(s1);
        if (getSettings().showTokens) {
            const st = tokenCounts.get(name);
            const s2 = document.createElement('span');
            s2.dataset.wigStatTokens = '1';
            s2.textContent = st?.done ? `${tokenLabel(st.total, st.estimated)} tokens` : '… tokens';
            stats.appendChild(s2);
        }
        const folderCount = new Set([...info.folders.keys(), ...(getSettings().folderOrder[name] ?? [])]).size;
        const s3 = document.createElement('span');
        s3.textContent = `${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`;
        stats.appendChild(s3);
    }
    const badges = document.createElement('span');
    badges.className = 'wig-badges wig-bp-badges';
    for (const b of bindings) {
        const s2 = document.createElement('span');
        s2.className = `wig-badge wig-badge-${b}`;
        s2.textContent = b;
        badges.appendChild(s2);
    }
    if (manual && !bindings.has(manual)) {
        const s2 = document.createElement('span');
        s2.className = 'wig-badge wig-badge-manual';
        s2.textContent = `${manual} ✎`;
        badges.appendChild(s2);
    }
    if (badges.childElementCount) stats.appendChild(badges);

    const actions = document.createElement('div');
    actions.className = 'wig-bp-actions';
    const nativeBtn = document.createElement('div');
    nativeBtn.className = 'menu_button';
    nativeBtn.innerHTML = '<i class="fa-solid fa-book-open"></i><span>Native editor</span>';
    nativeBtn.title = 'Open this lorebook in the SillyTavern World Info editor';
    nativeBtn.addEventListener('click', () => openNativeAt(name, null));
    const globalBtn = document.createElement('div');
    globalBtn.className = 'menu_button' + (bindings.has('global') ? ' wig-on' : '');
    globalBtn.innerHTML = `<i class="fa-solid fa-globe"></i><span>${bindings.has('global') ? 'Global: on' : 'Global: off'}</span>`;
    globalBtn.title = 'Toggle inclusion in the Global World Info selection';
    globalBtn.addEventListener('click', () => setGlobalActive(name, !bindings.has('global')));
    const exportBtn = document.createElement('div');
    exportBtn.className = 'menu_button';
    exportBtn.innerHTML = '<i class="fa-solid fa-file-export"></i><span>Export</span>';
    exportBtn.title = 'Download this lorebook as a JSON file';
    exportBtn.addEventListener('click', () => exportBook(name));
    const dupBtn = document.createElement('div');
    dupBtn.className = 'menu_button';
    dupBtn.innerHTML = '<i class="fa-solid fa-clone"></i><span>Duplicate</span>';
    dupBtn.title = 'Create a copy of this lorebook';
    dupBtn.addEventListener('click', () => duplicateBook(name));
    actions.append(nativeBtn, globalBtn, exportBtn, dupBtn);

    infoBox.append(nameRow, stats, actions);
    head.append(cover, infoBox);
}

// ------------------------------- entries page (folders + entry rows)
async function renderPopupEntriesPage() {
    const bp = state.bp;
    const page = bp ? $('.wig-bp-page-entries', bp.dlg?.content ?? document) : null;
    if (!bp || !page) return;
    const book = bp.name;
    bp.lastSig = null; // fresh page must render at least once (rename-safe)
    const initial = await ctx.loadWorldInfo(book);
    if (!initial?.entries) { page.textContent = 'Could not load entries.'; return; }
    invalidateBooks(book);
    await getBookInfo(book);

    const tools = document.createElement('div');
    tools.className = 'wig-bp-tools';
    // Filter + sort live in one non-breaking cluster so they always share a row.
    const find = document.createElement('div');
    find.className = 'wig-bp-find';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'text_pole';
    search.placeholder = 'Filter…';
    search.value = bp.filter;
    const sort = document.createElement('select');
    sort.className = 'text_pole';
    for (const [v, label] of [['default', 'Editor order'], ['alpha', 'A → Z'], ['alpha-desc', 'Z → A'], ['order', 'Insertion order']]) {
        sort.append(new Option(label, v));
    }
    sort.value = bp.sort;
    find.append(search, sort);
    const addEntryBtn = mkPopupBtn('fa-plus', 'Entry', () => addEntry(book));
    const addFolderBtn = mkPopupBtn('fa-folder-plus', 'Folder', () => newFolder(book));
    const collapseBtn = mkPopupBtn('fa-compress', '', () => setAllFoldersCollapsed(book, true), 'Collapse all folders');
    const expandBtn = mkPopupBtn('fa-expand', '', () => setAllFoldersCollapsed(book, false), 'Expand all folders');
    tools.append(find, addEntryBtn, addFolderBtn, collapseBtn, expandBtn);

    const list = document.createElement('div');
    list.className = 'wig-bp-list';
    page.replaceChildren(tools, list);

    // loadWorldInfo() returns a deep clone on EVERY call (worldInfoCache is
    // a StructuredCloneMap with cloneOnGet), so never close over a snapshot —
    // reload on every data-driven rerender. Search/sort reuse currentEntries.
    let currentEntries = Object.values(initial.entries);
    const renderList = () => renderEntryList(list, book, currentEntries);
    let lastPopupSig = null; // signature of the last rendered entry set
    bp.rerender = async () => {
        const fresh = await ctx.loadWorldInfo(book);
        currentEntries = Object.values(fresh?.entries ?? {});
        // Prune drafts whose entries were deleted elsewhere (avoids phantom
        // guard warnings for entries that no longer exist)
        const live = new Set(currentEntries.map((x) => x.uid));
        let pruned = false;
        for (const uid of [...bp.drafts]) {
            if (!live.has(uid)) { bp.drafts.delete(uid); bp.stash.delete(uid); pruned = true; }
        }
        // Dirty-check (gallery-style signature guard): skip the DOM rebuild
        // when nothing visible changed. Unrelated events used to rebuild the
        // list under the user every time they fired — with an entry editor
        // open, that reset the textarea's scroll and focus on event-heavy
        // setups, twice a second.
        const sig = currentEntries.map((e) =>
            `${e.uid}:${e.displayIndex ?? 0}:${String(e.comment ?? '').length}:${String(e.content ?? '').length}:${folderOf(e) ?? ''}`).join('\u0001');
        if (!pruned && sig === bp.lastSig) return; // unchanged — keep the DOM (and open editors) intact
        bp.lastSig = sig;
        invalidateBooks(book);
        await getBookInfo(book);
        renderPopupHead();
        renderList();
        schedulePopupTokens(book, currentEntries); // background real-token pass
    };

    search.addEventListener('input', debounce(() => { bp.filter = search.value.trim().toLowerCase(); renderList(); }, 150));
    sort.addEventListener('change', () => { bp.sort = sort.value; renderList(); });

    await bp.rerender();
}

function mkPopupBtn(icon, label, onClick, title) {
    const b = document.createElement('div');
    b.className = 'menu_button wig-bp-btn';
    if (title) b.title = title;
    const i = document.createElement('i');
    i.className = 'fa-solid ' + icon;
    b.appendChild(i);
    if (label) {
        const s = document.createElement('span');
        s.textContent = label;
        b.appendChild(s);
    }
    b.addEventListener('click', onClick);
    return b;
}

function sortEntriesFor(entries, mode) {
    const arr = [...entries];
    if (mode === 'alpha') arr.sort((a, b) => entryTitle(a).toLowerCase().localeCompare(entryTitle(b).toLowerCase()));
    else if (mode === 'alpha-desc') arr.sort((a, b) => entryTitle(b).toLowerCase().localeCompare(entryTitle(a).toLowerCase()));
    else if (mode === 'order') arr.sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    else arr.sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
    return arr;
}

function renderEntryList(listEl, book, entries) {
    const bp = state.bp;
    if (!bp) return;
    const scrollTop = listEl.scrollTop;
    const s = getSettings();
    const collapsed = s.collapsedFolders[book] ?? {};

    const q = bp.filter;
    const matching = q
        ? entries.filter((e) => {
            const hay = `${entryTitle(e)}\n${(e.key ?? []).join(', ')}\n${(e.keysecondary ?? []).join(', ')}\n${e.content ?? ''}`.toLowerCase();
            return hay.includes(q);
        })
        : entries;
    const sorted = sortEntriesFor(matching, bp.sort);

    const groups = new Map(); // folder|null -> entries
    for (const e of sorted) {
        const f = folderOf(e);
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(e);
    }
    const folderNames = new Set([...groups.keys()].filter(Boolean));
    // Include empty folders persisted in folderOrder so they render even
    // before any entry is assigned to them.
    for (const f of (s.folderOrder[book] ?? [])) folderNames.add(f);
    const order = orderedFolders(book, folderNames);
    for (const f of order) if (!groups.has(f)) groups.set(f, []);

    listEl.replaceChildren();

    const makeFolderBlock = (folder /* string|null */) => {
        const isUnsorted = folder === null;
        const fname = isUnsorted ? UNSORTED : folder;
        const groupEntries = groups.get(folder) ?? [];

        const block = document.createElement('div');
        block.className = 'wig-bp-folder' + (collapsed[fname] ? ' collapsed' : '');
        block.dataset.folder = fname;

        const head = document.createElement('div');
        head.className = 'wig-bp-folder-head';
        const chev = document.createElement('i');
        chev.className = 'fa-solid fa-circle-chevron-down wig-bp-chev';
        const icon = document.createElement('i');
        icon.className = 'fa-solid ' + (isUnsorted ? 'fa-inbox' : 'fa-folder');
        const label = document.createElement('span');
        label.className = 'wig-bp-folder-name';
        label.textContent = isUnsorted ? 'Ungrouped' : folder;
        const count = document.createElement('span');
        count.className = 'wig-bp-folder-count';
        count.textContent = String(groupEntries.length);
        const kebab = document.createElement('i');
        kebab.className = 'fa-solid fa-ellipsis-vertical wig-bp-kebab';
        head.append(chev, icon, label, count, kebab);

        head.addEventListener('click', (e) => {
            if (e.target === kebab) return;
            const c = s.collapsedFolders[book] ??= {};
            c[fname] = !c[fname];
            saveSettings();
            block.classList.toggle('collapsed', !!c[fname]);
        });
        kebab.addEventListener('click', (e) => {
            e.stopPropagation();
            folderMenu(book, folder, kebab);
        });

        // Named folder heads are drag handles (reorder); every head is a drop
        // zone for entries (move into folder) and, during a folder drag, an
        // insertion point (top half = before, bottom half = after; dropping
        // on Ungrouped = move to end).
        if (!isUnsorted) {
            head.draggable = true;
            head.title = 'Click to collapse · drag to reorder';
            head.addEventListener('dragstart', (ev) => {
                bp.draggingUid = null;
                bp.draggingFolder = fname;
                ev.dataTransfer.effectAllowed = 'move';
                try {
                    // Firefox refuses to start a drag without data
                    ev.dataTransfer.setData('text/plain', fname);
                    ev.dataTransfer.setData('application/x-wig-folder', fname);
                } catch { /* older browsers */ }
                block.classList.add('wig-folder-dragging');
            });
            head.addEventListener('dragend', () => {
                bp.draggingFolder = null;
                clearDragIndicators();
            });
        }

        head.addEventListener('dragover', (ev) => {
            if (bp.draggingFolder) {
                if (fname === bp.draggingFolder) return; // no self-insert
                ev.preventDefault();
                ev.dataTransfer.dropEffect = 'move';
                if (isUnsorted) {
                    head.classList.add('wig-drop-target');
                } else {
                    const r = head.getBoundingClientRect();
                    const after = ev.clientY > r.top + r.height / 2;
                    block.classList.toggle('wig-insert-before', !after);
                    block.classList.toggle('wig-insert-after', after);
                }
                return;
            }
            if (bp.draggingUid === null) return;
            ev.preventDefault();
            head.classList.add('wig-drop-target');
        });
        head.addEventListener('dragleave', () => {
            head.classList.remove('wig-drop-target');
            block.classList.remove('wig-insert-before', 'wig-insert-after');
        });
        head.addEventListener('drop', async (ev) => {
            ev.preventDefault();
            clearDragIndicators();
            if (bp.draggingFolder) {
                const dragged = bp.draggingFolder;
                bp.draggingFolder = null;
                if (dragged && dragged !== fname) {
                    if (isUnsorted) moveFolderToEnd(book, dragged);
                    else {
                        const r = head.getBoundingClientRect();
                        reorderFolder(book, dragged, fname, ev.clientY > r.top + r.height / 2);
                    }
                }
                return;
            }
            if (bp.draggingUid === null) return;
            const uid = bp.draggingUid;
            bp.draggingUid = null;
            await moveEntries(book, [uid], isUnsorted ? null : folder);
        });

        const body = document.createElement('div');
        body.className = 'wig-bp-folder-body';
        for (const e2 of groupEntries) body.appendChild(buildEntryRow(book, e2));
        block.append(head, body);
        return block;
    };

    for (const f of order) if (groups.has(f)) listEl.appendChild(makeFolderBlock(f));
    if (groups.has(null)) listEl.appendChild(makeFolderBlock(null));
    if (!listEl.childElementCount) {
        const empty = document.createElement('div');
        empty.className = 'wig-bp-empty';
        empty.textContent = q ? 'No entries match the filter.' : 'No entries yet — add one with “Entry”.';
        listEl.appendChild(empty);
    }
    listEl.scrollTop = scrollTop;
}

function folderMenu(book, folder, anchor) {
    const isUnsorted = folder === null;
    const items = [
        { icon: 'fa-plus', label: 'New entry here', action: () => addEntry(book, isUnsorted ? null : folder) },
    ];
    if (!isUnsorted) {
        items.push(
            { icon: 'fa-pencil', label: 'Rename folder…', action: () => renameFolder(book, folder) },
            { icon: 'fa-arrow-up', label: 'Move folder up', action: () => moveFolderOrder(book, folder, -1) },
            { icon: 'fa-arrow-down', label: 'Move folder down', action: () => moveFolderOrder(book, folder, 1) },
            { type: 'divider' },
            { icon: 'fa-trash-can', label: 'Delete folder', danger: true, action: () => deleteFolder(book, folder) },
        );
    } else {
        items.push({ icon: 'fa-compress', label: 'Collapse all folders', action: () => setAllFoldersCollapsed(book, true) });
        items.push({ icon: 'fa-expand', label: 'Expand all folders', action: () => setAllFoldersCollapsed(book, false) });
    }
    showMenu(items, anchor);
}

function setAllFoldersCollapsed(book, collapsed) {
    const c = getSettings().collapsedFolders[book] ??= {};
    const info = bookCache.get(book); // ← keep this one; delete the old `const data = ...` line
    const names = new Set([...(info?.folders.keys() ?? []), ...(getSettings().folderOrder[book] ?? [])]);
    for (const f of names) c[f] = collapsed;
    saveSettings();
    state.bp?.rerender?.();
}

// ------------------------------- entry rows + inline editor
function buildEntryRow(book, e) {
    const bp = state.bp;
    const row = document.createElement('div');
    row.className = 'wig-bp-entry' + (e.disable ? ' disabled' : '');
    row.dataset.uid = String(e.uid);

    const head = document.createElement('div');
    head.className = 'wig-bp-entry-head';
    const grip = document.createElement('i');
    grip.className = 'fa-solid fa-grip-vertical wig-bp-grip';
    grip.title = 'Drag onto a folder header to move';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = !e.disable;
    enabled.title = e.disable ? 'Enable entry' : 'Disable entry';
    enabled.addEventListener('click', (ev) => ev.stopPropagation());
    enabled.addEventListener('change', async () => {
        const data = await ctx.loadWorldInfo(book);
        const entry = data?.entries?.[e.uid];
        if (!entry) return;
        entry.disable = !enabled.checked;
        await ctx.saveWorldInfo(book, data);
        invalidateBooks(book);
        row.classList.toggle('disabled', entry.disable);
        renderGallery();
    });
    const ttl = document.createElement('span');
    ttl.className = 'wig-bp-entry-title';
    ttl.textContent = entryTitle(e);
    const meta = document.createElement('span');
    meta.className = 'wig-bp-entry-meta';
    const posLabel = (POSITIONS.find(([, v]) => v === (e.position ?? 0)) ?? [''])[0];
    const bits = [];
    if (e.constant) bits.push('⟳ constant');
    if (e.vectorized) bits.push('⌗ vectorized');
    bits.push(posLabel);
    if (e.key?.length) bits.push(`${e.key.length} key${e.key.length === 1 ? '' : 's'}`);
    meta.textContent = bits.join(' · ');
    if (getSettings().showTokens) {
        const st = tokenCounts.get(book);
        const tokSpan = document.createElement('span');
        tokSpan.dataset.wigTokenEntry = String(e.uid);
        const cached = st?.perEntry.get(e.uid);
        tokSpan.textContent = ` · ${cached !== undefined ? tokenLabel(cached, st.estimated) : '…'} tk`;
        meta.appendChild(tokSpan);
    }
    const kebab = document.createElement('i');
    kebab.className = 'fa-solid fa-ellipsis-vertical wig-bp-kebab';
    kebab.addEventListener('click', (ev) => {
        ev.stopPropagation();
        entryMenu(book, e, kebab);
    });

    head.append(grip, enabled, ttl, meta, kebab);
    head.addEventListener('click', () => {
        const open = !row.classList.contains('open');
        row.classList.toggle('open', open);
        row.draggable = !open; // don't fight text selection / accidental drags while editing
        if (open) {
            bp?.expanded.add(e.uid);
            if (!$('.wig-bp-editor', row)) row.appendChild(buildEntryEditor(book, e));
        } else {
            bp?.expanded.delete(e.uid);
        }
    });

    // HTML5 drag: the whole row is draggable, unless its editor is open
    row.draggable = true;
    row.addEventListener('dragstart', (ev) => {
        if (bp) bp.draggingFolder = null;
        bp.draggingUid = e.uid;
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', String(e.uid)); } catch { /* IE quirk */ }
        row.classList.add('wig-dragging');
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('wig-dragging');
        if (bp) bp.draggingUid = null;
        clearDragIndicators();
    });

    row.appendChild(head);

    if (bp.expanded.has(e.uid)) {
        row.classList.add('open');
        row.appendChild(buildEntryEditor(book, e));
        row.draggable = false;   // ← add this
    }
	if (bp?.drafts?.has(e.uid)) row.setAttribute('data-wig-draft', '1');
    return row;
}

// ------------------------------- cross-book send (move / copy)
async function sendToBookMenu(fromBook, uids, anchor) {
    const names = ((await ctx.getWorldInfoNames()) ?? []).filter((n) => n !== fromBook);
    if (!names.length) { toast('warning', 'No other lorebooks to send to.'); return; }
    const what = uids.length === 1 ? 'entry' : `${uids.length} entries`;
    const items = [{ type: 'search', placeholder: 'Filter books…' }];
    for (const n of names) {
        items.push({
            icon: 'fa-book',
            label: n,
            action: () => showMenu([
                { icon: 'fa-right-left', label: `Move ${what} to "${n}"`, action: () => doTransfer(fromBook, uids, n, true) },
                { icon: 'fa-clone', label: `Copy ${what} to "${n}"`, action: () => doTransfer(fromBook, uids, n, false) },
            ], anchor),
        });
    }
    showMenu(items, anchor);
}

async function doTransfer(fromBook, uids, toBook, move) {
    let n = 0;
    try {
        n = await transferEntries(fromBook, uids, toBook, move);
    } catch (e) {
        console.error(`[${MODULE_NAME}] transfer failed`, e);
        toast('error', 'Transfer failed.');
        return;
    }
    if (!n) { toast('warning', 'Nothing was transferred.'); return; }
    toast('success', `${move ? 'Moved' : 'Copied'} ${n} ${n === 1 ? 'entry' : 'entries'} to "${toBook}".`);
    enterSelectMode(false);
    renderGallery();
    if (state.bp?.name === fromBook || state.bp?.name === toBook) await state.bp.rerender?.();
    if (state.view === 'editor') { refreshFolderBar(); applyFolderFilter(); }
}

function entryMenu(book, e, anchor) {
    showMenu([
        // Sub-menus anchor to the kebab (stable), never the clicked row —
        // the row's menu is removed from the DOM before this action runs,
        // and a detached element's rect is all zeros.
        { icon: 'fa-folder', label: 'Move to folder…', action: () => folderPickerPopup(book, [e.uid], anchor) },
        { icon: 'fa-book', label: 'Send to another book…', action: () => sendToBookMenu(book, [e.uid], anchor) },
        { icon: 'fa-clone', label: 'Duplicate', action: () => duplicateEntry(book, e.uid) },
        { icon: 'fa-up-right-from-square', label: 'Open in native editor', action: () => openNativeAt(book, e.uid) },
        { type: 'divider' },
        { icon: 'fa-trash-can', label: 'Delete entry', danger: true, action: () => deleteEntry(book, e.uid) },
    ], anchor);
}

function fld(labelText, inputEl) {
    const wrap = document.createElement('label');
    wrap.className = 'wig-bp-field';
    const l = document.createElement('span');
    l.textContent = labelText;
    wrap.append(l, inputEl);
    return wrap;
}

// world_info_logic enum: AND_ANY 0, NOT_ALL 1, NOT_ANY 2, AND_ALL 3
const LOGIC = [['AND ANY', 0], ['NOT ALL', 1], ['NOT ANY', 2], ['AND ALL', 3]];

const SCAN_SOURCES = [
    ['Persona description', 'matchPersonaDescription'],
    ['Character description', 'matchCharacterDescription'],
    ['Character personality', 'matchCharacterPersonality'],
    ['Character depth prompt', 'matchCharacterDepthPrompt'],
    ['Scenario', 'matchScenario'],
    ['Creator notes', 'matchCreatorNotes'],
];

function triSelect(value) {
    const sel = document.createElement('select');
    sel.append(new Option('Default', ''), new Option('On', '1'), new Option('Off', '0'));
    sel.value = value === true ? '1' : value === false ? '0' : '';
    return sel;
}
const triValue = (sel) => (sel.value === '' ? null : sel.value === '1');

function numInput(value, { min = 0, max = 1000000, placeholder = '' } = {}) {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.placeholder = placeholder;
    i.value = value ?? '';
    return i;
}

function wrapCheck(input, text) {
    const span = document.createElement('span');
    span.textContent = text;
    const label = document.createElement('label');
    label.className = 'checkbox_label wig-bp-check';
    label.append(input, span);
    return label;
}

function editorSection(title, icon) {
    const sec = document.createElement('div');
    sec.className = 'wig-bp-sec closed';
    const head = document.createElement('div');
    head.className = 'wig-bp-sec-head';
    const ic = document.createElement('i');
    ic.className = 'fa-solid ' + icon;
    const label = document.createElement('span');
    label.textContent = title;
    const chev = document.createElement('i');
    chev.className = 'fa-solid fa-chevron-down wig-bp-sec-chev';
    head.append(ic, label, chev);
    const body = document.createElement('div');
    body.className = 'wig-bp-sec-body';
    head.addEventListener('click', () => sec.classList.toggle('closed'));
    sec.append(head, body);
    return { sec, body };
}

// ------------------------------- draft harvest / restore
// Drafts are stashed as {field: value} maps keyed by uid, tagged onto each
// control via data-wig-field. Rebuilding an editor re-applies the stash, so
// unsaved edits survive list rebuilds (search, external changes, PTMT-driven
// SETTINGS_UPDATED refreshes) and even book renames.
function harvestDraft(ed) {
    const v = {};
    for (const el of ed.querySelectorAll('[data-wig-field]')) {
        v[el.dataset.wigField] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return v;
}

function restoreDraft(ed, v) {
    if (!v) return;
    for (const el of ed.querySelectorAll('[data-wig-field]')) {
        const f = el.dataset.wigField;
        if (!(f in v)) continue;
        if (el.type === 'checkbox') el.checked = !!v[f];
        else el.value = v[f];
    }
    // Re-run dependent UI: role-field visibility + live token counter
    ed.querySelector('[data-wig-field="position"]')?.dispatchEvent(new Event('change'));
    ed.querySelector('[data-wig-field="content"]')?.dispatchEvent(new Event('input'));
}

// ---------------------------------------------------------- character filter
// Two storage generations:
//  - Release (current): { isExclude, names: [extensionless avatar filenames],
//    tags: [tag ID strings] } — verified against world-info.js.
//  - Staging/future (PR #5666): flat array of { type, name, state } items
//    (character/tag/persona, oneOf/required/excluded); ST migrates legacy
//    data on load. We read/write whichever generation we find, and the UI
//    upgrades itself (three-state cycle + personas) when the build has it.
const CF_STATES_ARRAY = ['oneOf', 'required', 'excluded'];
const CF_STATES_LEGACY = ['oneOf', 'excluded']; // legacy format can't express AND

let cfApiCache; // undefined = unresolved, false = legacy build, true = array-model build
async function cfSupportsArrayModel() {
    if (cfApiCache === undefined) {
        try {
            const wi = await import('../../../world-info.js');
            cfApiCache = Boolean(wi?.CHARACTER_FILTER_TYPES);
        } catch { cfApiCache = false; }
    }
    return cfApiCache;
}

let tagsCache; // undefined = unresolved, null = unavailable, module = loaded
async function loadTags() {
    if (tagsCache === undefined) {
        try {
            const t = await import('../../../tags.js');
            tagsCache = Array.isArray(t?.tags) ? t : null;
        } catch { tagsCache = null; }
    }
    return tagsCache;
}

// Native convention: characters are stored by avatar filename w/o extension
const charKeyOf = (ch) => String(ch?.avatar ?? '').replace(/\.[^.]+$/, '');

function readCharacterFilter(entry) {
    const cf = entry?.characterFilter;
    const norm = { format: null, characters: new Map(), tags: new Map(), personas: new Map() };
    if (Array.isArray(cf)) {
        norm.format = 'array';
        for (const it of cf) {
            if (!it?.type || it?.name === undefined) continue;
            const state = CF_STATES_ARRAY.includes(it.state) ? it.state : 'oneOf';
            const map = it.type === 'character' ? norm.characters
                : it.type === 'tag' ? norm.tags
                : it.type === 'persona' ? norm.personas : null;
            if (map) map.set(String(it.name), state);
        }
    } else if (cf && typeof cf === 'object') {
        norm.format = 'object';
        const state = cf.isExclude ? 'excluded' : 'oneOf';
        for (const n of cf.names ?? []) norm.characters.set(String(n), state);
        for (const t of cf.tags ?? []) norm.tags.set(String(t), state);
    }
    return norm;
}

function writeCharacterFilter(format, norm) {
    if (format === 'array') {
        const items = [];
        for (const [name, state] of norm.characters) items.push({ type: 'character', name, state });
        for (const [name, state] of norm.tags) items.push({ type: 'tag', name, state });
        for (const [name, state] of norm.personas) items.push({ type: 'persona', name, state });
        return items;
    }
    // Legacy object format: cannot express per-item AND or personas. If any
    // item is 'excluded', the filter flips to exclude-mode keeping only those.
    const chars = [...norm.characters], tags = [...norm.tags];
    if (norm.personas.size) console.warn(`[${MODULE_NAME}] persona filter items dropped: this build stores the legacy characterFilter format`);
    const excluded = [...chars, ...tags].some(([, s]) => s === 'excluded');
    return {
        isExclude: excluded,
        names: chars.filter(([, s]) => !excluded || s === 'excluded').map(([n]) => n),
        tags: tags.filter(([, s]) => !excluded || s === 'excluded').map(([n]) => n),
    };
}

function mkChipNote(text) {
    const s = document.createElement('span');
    s.className = 'wig-bp-note';
    s.textContent = text;
    return s;
}

function buildEntryEditor(book, e) {
    const ed = document.createElement('div');
    ed.className = 'wig-bp-editor';

    // ---- Title
    const comment = document.createElement('input');
    comment.type = 'text';
    comment.value = e.comment ?? '';
    comment.placeholder = 'Title / memo';
    const rowTitle = document.createElement('div');
    rowTitle.className = 'wig-bp-editor-row';
    rowTitle.append(fld('Title', comment));

    // ---- Keys + logic
    const keys = document.createElement('input');
    keys.type = 'text';
    keys.value = (e.key ?? []).join(', ');
    keys.placeholder = 'Comma separated (or /regex/)';
    const keys2 = document.createElement('input');
    keys2.type = 'text';
    keys2.value = (e.keysecondary ?? []).join(', ');
    keys2.placeholder = 'Optional secondary keys';
    const selLogic = document.createElement('select');
    for (const [label, v] of LOGIC) selLogic.append(new Option(label, String(v)));
    selLogic.value = String(e.selectiveLogic ?? 0);
    const rowKeys = document.createElement('div');
    rowKeys.className = 'wig-bp-editor-row';
    rowKeys.append(fld('Primary keys', keys), fld('Secondary keys', keys2), fld('Logic', selLogic));

    // ---- Content (+ live token counter)
    const content = document.createElement('textarea');
    content.className = 'wig-bp-content';
    content.value = e.content ?? '';
    content.placeholder = 'Entry content…';
    content.rows = Math.min(14, Math.max(4, String(e.content ?? '').split('\n').length + 1));
    const contentBox = document.createElement('div');
    contentBox.className = 'wig-bp-content-wrap';
    const liveTok = document.createElement('div');
    liveTok.className = 'wig-bp-token-live';
    const updateLiveTokens = debounce(async () => {
        if (!getSettings().showTokens) { liveTok.textContent = ''; return; }
        const n = await countTokens(content.value);
        liveTok.textContent = n === null ? '' : `${fmtTokens(n)} tokens`;
    }, 400);
    content.addEventListener('input', updateLiveTokens);
    updateLiveTokens();
    contentBox.append(content, liveTok);

    // ---- Positioning
    const pos = document.createElement('select');
    for (const [label, v] of POSITIONS) pos.append(new Option(label, String(v)));
    pos.value = String(e.position ?? 0);
    const order = numInput(e.order ?? 100, { max: 1000 });
    const depth = numInput(e.depth ?? 4, { max: 100 });
    const role = document.createElement('select');
    for (const [label, v] of ROLES) role.append(new Option(label, String(v)));
    role.value = String(e.role ?? 0);
    const params = document.createElement('div');
    params.className = 'wig-bp-editor-row wig-bp-params';
    params.append(fld('Position', pos), fld('Order', order), fld('Depth', depth), fld('Role', role));
    const syncRole = () => {
        const f = role.closest('.wig-bp-field');
        if (f) f.style.display = Number(pos.value) >= 4 ? '' : 'none';
    };
    pos.addEventListener('change', syncRole);
    syncRole();

    // ---- Flags
    const constant = document.createElement('input');
    constant.type = 'checkbox';
    constant.checked = !!e.constant;
    const vectorized = document.createElement('input');
    vectorized.type = 'checkbox';
    vectorized.checked = !!e.vectorized;
    const flags = document.createElement('div');
    flags.className = 'wig-bp-editor-row wig-bp-checkrow';
    flags.append(wrapCheck(constant, 'Constant'), wrapCheck(vectorized, 'Vectorized'));

    // ---- Matching
    const caseSel = triSelect(e.caseSensitive);
    const wholeSel = triSelect(e.matchWholeWords);
    const scanDepth = numInput(e.scanDepth, { max: 100, placeholder: 'Global' });
    const secMatch = editorSection('Matching', 'fa-magnifying-glass');
    const matchRow = document.createElement('div');
    matchRow.className = 'wig-bp-editor-row';
    matchRow.append(fld('Match case', caseSel), fld('Whole words', wholeSel), fld('Scan depth', scanDepth));
    secMatch.body.append(matchRow);

    // ---- Extra scan sources
    const sourceChecks = SCAN_SOURCES.map(([label, field]) => {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = !!e[field];
        return { input: c, field, label: wrapCheck(c, label) };
    });
    const secScan = editorSection('Extra scan sources', 'fa-satellite-dish');
    const scanRow = document.createElement('div');
    scanRow.className = 'wig-bp-editor-row wig-bp-checkrow';
    scanRow.append(...sourceChecks.map((s) => s.label));
    secScan.body.append(scanRow);

    // ---- Probability
    const useProb = document.createElement('input');
    useProb.type = 'checkbox';
    useProb.checked = e.useProbability !== false;
    const prob = numInput(e.probability ?? 100, { max: 100 });
    const secProb = editorSection('Probability', 'fa-dice');
    const probRow = document.createElement('div');
    probRow.className = 'wig-bp-editor-row wig-bp-checkrow';
    probRow.append(wrapCheck(useProb, 'Use probability'), fld('Chance (%)', prob));
    secProb.body.append(probRow);

    // ---- Inclusion group
    const group = document.createElement('input');
    group.type = 'text';
    group.value = e.group ?? '';
    group.placeholder = 'Group name';
    const groupWeight = numInput(e.groupWeight ?? 100, { min: 1, max: 100 });
    const scoringSel = triSelect(e.useGroupScoring);
    const groupOverride = document.createElement('input');
    groupOverride.type = 'checkbox';
    groupOverride.checked = !!e.groupOverride;
    const secGroup = editorSection('Inclusion group', 'fa-layer-group');
    const gRow1 = document.createElement('div');
    gRow1.className = 'wig-bp-editor-row';
    gRow1.append(fld('Group', group), fld('Weight', groupWeight), fld('Group scoring', scoringSel));
    const gRow2 = document.createElement('div');
    gRow2.className = 'wig-bp-editor-row wig-bp-checkrow';
    gRow2.append(wrapCheck(groupOverride, 'Override (always include)'));
    secGroup.body.append(gRow1, gRow2);

    // ---- Timed effects
    const sticky = numInput(e.sticky ?? 0, { max: 10000 });
    const cooldown = numInput(e.cooldown ?? 0, { max: 10000 });
    const delay = numInput(e.delay ?? 0, { max: 10000 });
    const secTimed = editorSection('Timed effects', 'fa-clock');
    const tRow = document.createElement('div');
    tRow.className = 'wig-bp-editor-row';
    tRow.append(fld('Sticky (turns)', sticky), fld('Cooldown (turns)', cooldown), fld('Delay (messages)', delay));
    secTimed.body.append(tRow);

    // ---- Recursion & misc
    const preventRec = document.createElement('input');
    preventRec.type = 'checkbox';
    preventRec.checked = !!e.preventRecursion;
    const excludeRec = document.createElement('input');
    excludeRec.type = 'checkbox';
    excludeRec.checked = !!e.excludeRecursion;
    const delayRec = document.createElement('input');
    delayRec.type = 'checkbox';
    delayRec.checked = !!e.delayUntilRecursion;
    const addMemo = document.createElement('input');
    addMemo.type = 'checkbox';
    addMemo.checked = e.addMemo !== false;
    const automationId = document.createElement('input');
    automationId.type = 'text';
    automationId.value = e.automationId ?? '';
    automationId.placeholder = 'For scripts / regex';
    const secMisc = editorSection('Recursion & misc', 'fa-rotate');
    const mRow1 = document.createElement('div');
    mRow1.className = 'wig-bp-editor-row wig-bp-checkrow';
    mRow1.append(
        wrapCheck(preventRec, 'Prevent further recursion'),
        wrapCheck(excludeRec, 'Not invocable by recursion'),
        wrapCheck(delayRec, 'Delay until recursed'),
        wrapCheck(addMemo, 'Include memo'),
    );
    const mRow2 = document.createElement('div');
    mRow2.className = 'wig-bp-editor-row';
    mRow2.append(fld('Automation ID', automationId));
    secMisc.body.append(mRow1, mRow2);

    // ---- Character filter (native parity: character + tag chips, plus persona
    // chips and three-state cycling on builds with the array model)
    const cfNorm = readCharacterFilter(e);
    const cfFormat = cfNorm.format ?? (cfApiCache === true ? 'array' : 'object');
    const cfStates = cfFormat === 'array' ? CF_STATES_ARRAY : CF_STATES_LEGACY;
    const cfInput = document.createElement('input');
    cfInput.type = 'hidden';
    cfInput.dataset.wigField = 'characterFilter';

    const secFilter = editorSection('Character filter', 'fa-user-check');
    const cfLegend = document.createElement('div');
    cfLegend.className = 'wig-bp-note';
    cfLegend.textContent = cfFormat === 'array'
        ? 'Click a chip to cycle: ○ one of (OR) → ✓ required (AND) → ✗ excluded (NOT) → off.'
        : 'Click a chip to cycle: include → exclude → off.';
    const lblChars = document.createElement('div');
    lblChars.className = 'wig-bp-chip-label';
    const lblTags = document.createElement('div');
    lblTags.className = 'wig-bp-chip-label';
    const lblPers = document.createElement('div');
    lblPers.className = 'wig-bp-chip-label';
    const charSearch = document.createElement('input');
    charSearch.type = 'text';
    charSearch.className = 'text_pole wig-bp-filter-search';
    charSearch.placeholder = 'Find character…';
    const charChips = document.createElement('div');
    charChips.className = 'wig-bp-chipbox';
    const tagChips = document.createElement('div');
    tagChips.className = 'wig-bp-chipbox';
    const persChips = document.createElement('div');
    persChips.className = 'wig-bp-chipbox';

    function cfSyncInput() {
        cfInput.value = JSON.stringify({
            format: cfFormat,
            characters: [...cfNorm.characters],
            tags: [...cfNorm.tags],
            personas: [...cfNorm.personas],
        });
    }
    function cfSerialize() {
        cfSyncInput();
        cfInput.dispatchEvent(new Event('input', { bubbles: true })); // mark draft dirty
        syncCfLabels();
    }
    function cfApplyInput() {
        try {
            const v = JSON.parse(cfInput.value || 'null');
            if (v && typeof v === 'object') {
                cfNorm.characters = new Map(v.characters ?? []);
                cfNorm.tags = new Map(v.tags ?? []);
                cfNorm.personas = new Map(v.personas ?? []);
            }
        } catch { /* corrupted draft value */ }
    }
    function syncCfLabels() {
        lblChars.textContent = cfNorm.characters.size ? `Characters (${cfNorm.characters.size})` : 'Characters';
        lblTags.textContent = cfNorm.tags.size ? `Tags (${cfNorm.tags.size})` : 'Tags';
        lblPers.textContent = cfNorm.personas.size ? `Personas (${cfNorm.personas.size})` : 'Personas';
    }
    const cfCycle = (map, key, chip) => {
        const idx = cfStates.indexOf(map.get(key)); // -1 = off
        const next = idx === -1 ? cfStates[0] : (idx + 1 < cfStates.length ? cfStates[idx + 1] : undefined);
        if (next === undefined) map.delete(key); else map.set(key, next);
        chip.dataset.cfState = next ?? '';
        cfSerialize();
    };
    const cfChip = (label, map, key, { img, tag, title } = {}) => {
        const chip = document.createElement('div');
        chip.className = 'wig-bp-chip-toggle';
        chip.dataset.cfState = map.get(key) ?? '';
        chip.title = title ?? label;
        if (img) {
            const im = document.createElement('img');
            im.src = img;
            im.onerror = () => im.remove();
            chip.appendChild(im);
        }
        const sp = document.createElement('span');
        sp.textContent = label;
        chip.appendChild(sp);
        if (tag?.color) chip.style.backgroundColor = tag.color;   // native tag colors
        if (tag?.color2) chip.style.color = tag.color2;
        chip.addEventListener('click', () => cfCycle(map, key, chip));
        return chip;
    };

    function renderCharChips() {
        charChips.replaceChildren();
        const all = ctx.characters ?? [];
        const q = charSearch.value.trim().toLowerCase();
        const shown = all.filter((c) => !q || String(c.name).toLowerCase().includes(q));
        if (!all.length) charChips.appendChild(mkChipNote('No characters available.'));
        else if (!shown.length) charChips.appendChild(mkChipNote('No characters match.'));
        for (const ch of shown) {
            // Stored identifiers are extensionless avatar filenames; match either
            // convention (and display names) for robustness, write the native one
            const key = [charKeyOf(ch), ch.avatar, ch.name].find((k) => cfNorm.characters.has(k)) ?? charKeyOf(ch);
            charChips.appendChild(cfChip(ch.name, cfNorm.characters, key, { img: safeThumb('avatar', ch.avatar) }));
        }
        // Ghost chips: selected items that no longer resolve to any character
        for (const [key] of cfNorm.characters) {
            if (!all.some((c) => charKeyOf(c) === key || c.avatar === key || c.name === key)) {
                charChips.appendChild(cfChip(`⚠ ${key}`, cfNorm.characters, key, { title: `Unresolved: ${key}` }));
            }
        }
        syncCfLabels();
    }

    async function renderTagChips() {
        tagChips.replaceChildren();
        let all = Array.isArray(ctx.tags) ? ctx.tags : null;      // primary: context registry
        if (!all) all = (await loadTags())?.tags ?? null;          // fallback: tags.js import
        if (!all) { tagChips.appendChild(mkChipNote('Tags unavailable on this build.')); return; }
        const sorted = [...all].sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!sorted.length) { tagChips.appendChild(mkChipNote('No tags defined yet — create them in the Tags manager.')); return; }
        for (const tag of sorted) {
            const key = [String(tag.id), String(tag.name)].find((k) => cfNorm.tags.has(k)) ?? String(tag.id);
            tagChips.appendChild(cfChip(tag.name, cfNorm.tags, key, { tag, title: `Tag: ${tag.name}` }));
        }
        for (const [key] of cfNorm.tags) {
            if (!sorted.some((t) => String(t.id) === key || String(t.name) === key)) {
                tagChips.appendChild(cfChip(`⚠ ${key}`, cfNorm.tags, key, { title: `Unresolved tag: ${key}` }));
            }
        }
        syncCfLabels();
    }

    function renderPersonaChips() {
        persChips.replaceChildren();
        const personas = Object.entries(ctx.powerUserSettings?.personas ?? {});
        if (!personas.length) { persChips.appendChild(mkChipNote('No personas defined.')); return; }
        for (const [pKey, pName] of personas) {
            const key = [pKey, pKey.replace(/\.[^.]+$/, ''), pName].find((k) => cfNorm.personas.has(k)) ?? pKey;
            persChips.appendChild(cfChip(pName || pKey, cfNorm.personas, key, { img: safeThumb('persona', pKey), title: `Persona: ${pName || pKey}` }));
        }
        syncCfLabels();
    }

    charSearch.addEventListener('input', renderCharChips);
    renderCharChips();
    renderTagChips();
    if (cfFormat === 'array') renderPersonaChips();
    cfSyncInput();
    secFilter.body.append(cfLegend, lblChars, charSearch, charChips, lblTags, tagChips, cfInput);
    if (cfFormat === 'array') secFilter.body.append(lblPers, persChips);

    // ---- Buttons
    const btns = document.createElement('div');
    btns.className = 'wig-bp-editor-btns';
    const save = mkPopupBtn('fa-floppy-disk', 'Save', async () => {
        const data = await ctx.loadWorldInfo(book);
        const entry = data?.entries?.[e.uid];
        if (!entry) { toast('error', 'Entry no longer exists.'); return; }
        entry.comment = comment.value.slice(0, 100); // MAX_COMMENT_LENGTH = 100
        entry.key = parseKeys(keys.value);
        entry.keysecondary = parseKeys(keys2.value);
        entry.selectiveLogic = Number(selLogic.value) || 0;
        entry.content = content.value;
        entry.position = Number(pos.value) || 0;
        entry.order = Number(order.value) || 0;
        entry.depth = Math.max(0, Number(depth.value) || 0);
        entry.role = Number(role.value) || 0;
        entry.constant = constant.checked;
        entry.vectorized = vectorized.checked;
        entry.caseSensitive = triValue(caseSel);
        entry.matchWholeWords = triValue(wholeSel);
        entry.scanDepth = scanDepth.value === '' ? null : Math.max(0, Number(scanDepth.value) || 0);
        for (const { input, field } of sourceChecks) entry[field] = input.checked;
        entry.useProbability = useProb.checked;
        entry.probability = Math.min(100, Math.max(0, Number(prob.value) || 0));
        entry.group = group.value.trim();
        entry.groupOverride = groupOverride.checked;
        entry.groupWeight = Math.min(100, Math.max(1, Number(groupWeight.value) || 100));
        entry.useGroupScoring = triValue(scoringSel);
        entry.sticky = Math.max(0, Number(sticky.value) || 0);
        entry.cooldown = Math.max(0, Number(cooldown.value) || 0);
        entry.delay = Math.max(0, Number(delay.value) || 0);
        entry.preventRecursion = preventRec.checked;
        entry.excludeRecursion = excludeRec.checked;
        entry.delayUntilRecursion = delayRec.checked;
        entry.addMemo = addMemo.checked;
        entry.automationId = automationId.value.trim();
        // Character filter: chip selections (native identifier conventions)
        cfApplyInput();
        if (cfNorm.characters.size || cfNorm.tags.size || cfNorm.personas.size) {
            entry.characterFilter = writeCharacterFilter(cfFormat, cfNorm);
        } else {
            delete entry.characterFilter;
        }
        await ctx.saveWorldInfo(book, data);
        invalidateBooks(book);
		        // Draft resolved — clear unsaved-changes tracking for this entry
        state.bp?.drafts?.delete(e.uid);
        state.bp?.stash?.delete(e.uid);
        ed.closest('.wig-bp-entry')?.removeAttribute('data-wig-draft');
        renderGallery();
        toast('success', 'Entry saved.');
        state.bp?.expanded.add(e.uid);
        await state.bp?.rerender?.();
    });
    const closeBtn = mkPopupBtn('fa-xmark', 'Close', () => {
        const row = ed.closest('.wig-bp-entry');
        row?.classList.remove('open');
        state.bp?.expanded.delete(e.uid);
        if (row) row.draggable = true;
    });
    const dup = mkPopupBtn('fa-clone', 'Duplicate', () => duplicateEntry(book, e.uid));
    const del = mkPopupBtn('fa-trash-can', 'Delete', () => deleteEntry(book, e.uid));
    btns.append(save, closeBtn, dup, del);

    ed.append(rowTitle, rowKeys, contentBox, params, flags,
        secMatch.sec, secScan.sec, secProb.sec, secGroup.sec, secTimed.sec, secMisc.sec, secFilter.sec, btns);
    // Match ST's standard input styling (same background as native editor fields)
    $$('input:not([type="checkbox"]), select, textarea', ed).forEach((el) => el.classList.add('text_pole'));
	    // ---- Unsaved-changes tracking
    // Tag every control with its field name so drafts harvest/restore generically
    for (const [el, field] of [
        [comment, 'comment'], [keys, 'key'], [keys2, 'keysecondary'], [selLogic, 'selectiveLogic'],
        [content, 'content'], [pos, 'position'], [order, 'order'], [depth, 'depth'], [role, 'role'],
        [constant, 'constant'], [vectorized, 'vectorized'],
        [caseSel, 'caseSensitive'], [wholeSel, 'matchWholeWords'], [scanDepth, 'scanDepth'],
        [useProb, 'useProbability'], [prob, 'probability'],
        [group, 'group'], [groupWeight, 'groupWeight'], [scoringSel, 'useGroupScoring'], [groupOverride, 'groupOverride'],
        [sticky, 'sticky'], [cooldown, 'cooldown'], [delay, 'delay'],
        [preventRec, 'preventRecursion'], [excludeRec, 'excludeRecursion'], [delayRec, 'delayUntilRecursion'],
        [addMemo, 'addMemo'], [automationId, 'automationId'],
        [cfInput, 'characterFilter'],
        ...sourceChecks.map((sc) => [sc.input, 'src_' + sc.field]),
    ]) el.dataset.wigField = field;

    const markDraft = () => {
        const bp = state.bp;
        if (!bp) return;
        bp.drafts.add(e.uid);
        bp.stash.set(e.uid, harvestDraft(ed));
        ed.closest('.wig-bp-entry')?.setAttribute('data-wig-draft', '1');
    };
    ed.addEventListener('input', markDraft);
    ed.addEventListener('change', markDraft);

    // Re-apply a pending draft (editor was rebuilt under the user)
    if (state.bp?.stash?.has(e.uid)) {
        restoreDraft(ed, state.bp.stash.get(e.uid));
        cfApplyInput();                    // chips read the restored hidden input
        renderCharChips();
        renderTagChips();
        if (cfFormat === 'array') renderPersonaChips();
    }
    return ed;
}

// ------------------------------- entry ops
async function addEntry(book, folder = null) {
    const data = await ctx.loadWorldInfo(book);
    if (!data?.entries) return;
    const entry = await makeNewEntry(data);
    if (folder) setEntryFolderField(entry, folder);
    data.entries[entry.uid] = entry;
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);
    mirrorToLM(book, [entry.uid], folder);
    renderGallery();
    state.bp?.expanded.add(entry.uid);
    await state.bp?.rerender?.();
    const row = $(`.wig-bp-entry[data-uid="${entry.uid}"]`);
    row?.scrollIntoView({ block: 'center' });
}

async function duplicateEntry(book, uid) {
    const data = await ctx.loadWorldInfo(book);
    const src = data?.entries?.[uid];
    if (!data || !src) return;
    const copy = await makeNewEntry(data);
    const clone = structuredClone(src);
    for (const k of Object.keys(copy)) copy[k] = clone[k] ?? copy[k];
    copy.uid = (Object.values(data.entries).map((e) => Number(e.uid)).reduce((a, b) => Math.max(a, b), -1)) + 1;
    copy.comment = `${entryTitle(src)} (copy)`.slice(0, 100);
    data.entries[copy.uid] = copy;
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);
    renderGallery();
    state.bp?.rerender?.();
    toast('success', 'Entry duplicated.');
}

// Next free uid in a book — ST's own generator when available, identical
// manual math otherwise. Safe to call repeatedly while appending: each call
// sees the entries added so far, so batch transfers get sequential uids.
function nextUidFor(book) {
    try {
        if (typeof wiModule?.getNewUid === 'function') return wiModule.getNewUid(book);
        if (typeof ctx.getNewUid === 'function') return ctx.getNewUid(book);
    } catch { /* fall through */ }
    const uids = Object.values(book?.entries ?? {}).map((e) => Number(e.uid)).filter(Number.isFinite);
    return (uids.length ? Math.max(...uids) : -1) + 1;
}

// Cross-book move/copy. Semantics match ST's native transfer (PRs #3768 +
// #4335): the entry is cloned verbatim — including extensions.lorebook_folder,
// so folder groupings travel with it and materialize in the target book —
// gets a fresh uid (uids are unique per lorebook, so they can't be kept),
// and lands at the end of the target (displayIndex). The original is
// deleted only on move. Save order is target first: if a move ever failed
// midway, the entry would exist in both books (recoverable) rather than
// neither (data loss).
async function transferEntries(fromBook, uidsIn, toBook, move) {
    if (!fromBook || !toBook || fromBook === toBook) return 0;
    const uids = [...new Set(uidsIn ?? [])];
    if (!uids.length) return 0;
    await loadWiModule();
    const src = await ctx.loadWorldInfo(fromBook);
    const dst = await ctx.loadWorldInfo(toBook);
    if (!src?.entries || !dst?.entries) return 0;

    let display = Object.keys(dst.entries).length;
    const placed = []; // { uid, folder } in the target
    for (const uid of uids) {
        const e = src.entries[uid];
        if (!e) continue;
        const clone = structuredClone(e);
        clone.uid = nextUidFor(dst);
        clone.displayIndex = display++;
        dst.entries[clone.uid] = clone;
        if (move) delete src.entries[uid];
        placed.push({ uid: clone.uid, folder: folderOf(clone) });
    }
    if (!placed.length) return 0;

    await ctx.saveWorldInfo(toBook, dst);
    if (move) await ctx.saveWorldInfo(fromBook, src);

    invalidateBooks(fromBook);
    invalidateBooks(toBook);
    tokenCounts.delete(fromBook); // gallery recounts both via signature check
    tokenCounts.delete(toBook);

    // Lorebook Manager: moved uids leave the source's map; the new uids
    // register at the target with their folders. Copy leaves source alone.
    if (move) {
        const lmSrc = lmWorldState(fromBook);
        if (lmSrc?.entries) {
            let touched = false;
            for (const uid of uids) {
                if (String(uid) in lmSrc.entries) { delete lmSrc.entries[String(uid)]; touched = true; }
            }
            if (touched) saveSettings();
        }
    }
    for (const p of placed) mirrorToLM(toBook, [p.uid], p.folder);
    return placed.length;
}

async function deleteEntry(book, uid) {
    const data = await ctx.loadWorldInfo(book);
    const entry = data?.entries?.[uid];
    if (!data || !entry) return;
    const ok = await ctx.Popup.show.confirm(`Delete "${entryTitle(entry)}"?`, 'This cannot be undone.');
    if (!ok) return;
    delete data.entries[uid];
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);
    state.bp?.drafts?.delete(uid);
    state.bp?.stash?.delete(uid);
    renderGallery();
    state.bp?.expanded.delete(uid);
    state.bp?.rerender?.();
    toast('success', 'Entry deleted.');
}

async function moveEntries(book, uids, folder) {
    if (!book || !uids.length) return;
    const data = await ctx.loadWorldInfo(book);
    if (!data?.entries) return;
    let changed = 0;
    for (const uid of uids) {
        const e = data.entries[uid];
        if (!e) continue;
        setEntryFolderField(e, folder);
        changed++;
    }
    if (!changed) return;
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);
    mirrorToLM(book, uids, folder);
    enterSelectMode(false);
    renderGallery();
    state.bp?.rerender?.();
    if (state.view === 'editor') jq('#world_editor_select').trigger('change');
    toast('success', `Moved ${changed} ${changed === 1 ? 'entry' : 'entries'} ${folder ? `to "${folder}"` : 'out of all folders'}.`);
}

// ------------------------------- folder ops (popup)
async function newFolder(book) {
    const name = await ctx.Popup.show.input('New folder', 'Folder name:', '');
    const f = String(name ?? '').trim();
    if (!f) return;
    if (RESERVED.has(f.toLowerCase())) { toast('warning', 'That folder name is reserved.'); return; }
    const order = getSettings().folderOrder[book] ?? [];
    if (order.some((x) => x.toLowerCase() === f.toLowerCase())) { toast('warning', 'Folder already exists.'); return; }
    order.push(f);
    getSettings().folderOrder[book] = order;
    saveSettings();
    state.bp?.rerender?.();
    toast('success', `Folder "${f}" created. Drag entries onto it.`);
}

async function renameFolder(book, oldName) {
    const input = await ctx.Popup.show.input('Rename folder', 'Folder name:', oldName);
    const nn = String(input ?? '').trim();
    if (!nn || nn === oldName) return;
    if (RESERVED.has(nn.toLowerCase())) { toast('warning', 'That folder name is reserved.'); return; }
    const s = getSettings();
    const order = s.folderOrder[book] ?? [];
    if (order.some((x) => x.toLowerCase() === nn.toLowerCase())) { toast('warning', 'A folder with that name already exists.'); return; }

    const data = await ctx.loadWorldInfo(book);
    if (!data?.entries) return;
    const moved = [];
    for (const e of Object.values(data.entries)) {
        if (folderOf(e) === oldName) { setEntryFolderField(e, nn); moved.push(e.uid); }
    }
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);

    const oi = order.indexOf(oldName);
    if (oi !== -1) order[oi] = nn; else order.push(nn);
    s.folderOrder[book] = order;
    const c = s.collapsedFolders[book];
    if (c && oldName in c) { c[nn] = c[oldName]; delete c[oldName]; }
    saveSettings();

    const lm = lmWorldState(book);
    if (lm) {
        for (const f of (lm.folders ?? [])) if (f.name === oldName) f.name = nn;
        for (const k of Object.keys(lm.entries ?? {})) if (lm.entries[k] === oldName) lm.entries[k] = nn;
        if (lm.collapsed && oldName in lm.collapsed) { lm.collapsed[nn] = lm.collapsed[oldName]; delete lm.collapsed[oldName]; }
        saveSettings();
    }
    void moved;
    renderGallery();
    state.bp?.rerender?.();
    if (state.view === 'editor') refreshFolderBar();
    toast('success', 'Folder renamed.');
}

async function deleteFolder(book, folderName) {
    const ok = await ctx.Popup.show.confirm(
        `Delete folder "${folderName}"?`,
        'Its entries will be moved to Ungrouped. The entries themselves are not deleted.',
    );
    if (!ok) return;
    const data = await ctx.loadWorldInfo(book);
    if (!data?.entries) return;
    const uids = [];
    for (const e of Object.values(data.entries)) {
        if (folderOf(e) === folderName) { setEntryFolderField(e, null); uids.push(e.uid); }
    }
    await ctx.saveWorldInfo(book, data);
    invalidateBooks(book);
    mirrorToLM(book, uids, null);

    const s = getSettings();
    s.folderOrder[book] = (s.folderOrder[book] ?? []).filter((x) => x !== folderName);
    if (s.collapsedFolders[book]) delete s.collapsedFolders[book][folderName];
    saveSettings();

    const lm = lmWorldState(book);
    if (lm) {
        lm.folders = (lm.folders ?? []).filter((f) => f.name !== folderName);
        for (const k of Object.keys(lm.entries ?? {})) if (lm.entries[k] === folderName) lm.entries[k] = '';
        delete lm.collapsed?.[folderName];
        saveSettings();
    }
    renderGallery();
    state.bp?.rerender?.();
    if (state.view === 'editor') refreshFolderBar();
    toast('success', 'Folder deleted.');
}

// ------------------------------- folder reorder (drag & drop)
function clearDragIndicators() {
    $$('.wig-drop-target, .wig-insert-before, .wig-insert-after, .wig-folder-dragging')
        .forEach((x) => x.classList.remove('wig-drop-target', 'wig-insert-before', 'wig-insert-after', 'wig-folder-dragging'));
}

function reorderFolder(book, dragged, target, placeAfter) {
    const order = getSettings().folderOrder[book] ?? [];
    if (!order.includes(dragged) || !order.includes(target) || dragged === target) return;
    const next = order.filter((f) => f !== dragged);
    next.splice(placeAfter ? next.indexOf(target) + 1 : next.indexOf(target), 0, dragged);
    getSettings().folderOrder[book] = next;
    saveSettings();
    syncLmFolderOrder(book);
    state.bp?.rerender?.();
}

function moveFolderToEnd(book, dragged) {
    const order = getSettings().folderOrder[book] ?? [];
    if (!order.includes(dragged)) return;
    getSettings().folderOrder[book] = [...order.filter((f) => f !== dragged), dragged];
    saveSettings();
    syncLmFolderOrder(book);
    state.bp?.rerender?.();
}

// Keep Lorebook Manager's folder order in sync when it tracks this book
// (its folders array is {name, order}, order = index).
function syncLmFolderOrder(book) {
    const lm = lmWorldState(book);
    if (!lm || !Array.isArray(lm.folders)) return;
    const order = getSettings().folderOrder[book] ?? [];
    for (const f of lm.folders) {
        const idx = order.indexOf(f.name);
        if (idx !== -1) f.order = idx;
    }
    saveSettings();
}

function moveFolderOrder(book, folderName, dir) {
    const order = getSettings().folderOrder[book] ?? [];
    const i = order.indexOf(folderName);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    getSettings().folderOrder[book] = order;
    saveSettings();
    state.bp?.rerender?.();
}

async function folderPickerPopup(book, uids, anchor) {
    const info = await getBookInfo(book);
    const items = orderedFolders(book, new Set(info.folders.keys())).map((f) => ({
        icon: 'fa-folder', label: f, action: () => moveEntries(book, uids, f),
    }));
    items.push({ type: 'divider' });
    items.push({
        icon: 'fa-folder-plus', label: 'New folder…',
        action: async () => {
            const name = await ctx.Popup.show.input('New folder', 'Folder name:', '');
            const f = String(name ?? '').trim();
            if (!f || RESERVED.has(f.toLowerCase())) { if (f) toast('warning', 'Invalid folder name.'); return; }
            const order = getSettings().folderOrder[book] ?? [];
            if (!order.includes(f)) order.push(f);
            getSettings().folderOrder[book] = order;
            saveSettings();
            await moveEntries(book, uids, f);
        },
    });
    items.push({ icon: 'fa-xmark', label: 'Move to Ungrouped', danger: true, action: () => moveEntries(book, uids, null) });
    showMenu(items, anchor);
}

// ------------------------------- settings page (popup)
function renderPopupSettingsPage() {
    const bp = state.bp;
    const page = bp ? $('.wig-bp-page-settings', bp.dlg?.content ?? document) : null;
    if (!bp || !page) return;
    const name = bp.name;
    const bindings = computeBindings(name);
    page.replaceChildren();

    const section = (title, icon) => {
        const sec = document.createElement('div');
        sec.className = 'wig-bp-section';
        const h = document.createElement('div');
        h.className = 'wig-bp-section-title';
        h.innerHTML = `<i class="fa-solid ${icon}"></i><span>${title}</span>`;
        sec.appendChild(h);
        page.appendChild(sec);
        return sec;
    };

    // Bindings
    const secB = section('Bindings', 'fa-link');
    const row = (icon, text, btnText, onClick, btnClass = '') => {
        const r = document.createElement('div');
        r.className = 'wig-bp-setting-row';
        const left = document.createElement('span');
        left.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`;
        const b = document.createElement('div');
        b.className = 'menu_button ' + btnClass;
        b.textContent = btnText;
        b.addEventListener('click', onClick);
        r.append(left, b);
        return r;
    };
    const personaName = findPersonaByBook(name);
    const chatLive = chatOpen() && ctxNow().chatMetadata?.world_info === name;
    const chatN = rememberedChatLinks(name).length;
    secB.append(
        row('fa-globe', bindings.has('global') ? 'Active in Global World Info' : 'Not in Global World Info',
            bindings.has('global') ? 'Remove' : 'Add', () => setGlobalActive(name, !bindings.has('global'))),
        row('fa-user', personaName ? `Bound to persona: ${ctx.powerUserSettings?.personas?.[personaName] ?? personaName}` : 'Not bound to any persona',
            'Manage…', (e) => menuAssignPersona(name, e.currentTarget)),
        row('fa-user-astronaut', primaryCharFor(name) ? `Primary book for: ${primaryCharFor(name).name}` : (extraCharsFor(name).length ? `Additional book for ${extraCharsFor(name).length} character(s)` : 'Not bound to any character'),
            'Manage…', (e) => menuAssignCharacter(name, e.currentTarget)),
        row('fa-comments',
            chatLive ? 'Bound to the current chat' : (chatN ? `Chat-linked in ${chatN} other chat${chatN === 1 ? '' : 's'}` : 'Not bound to any chat'),
            chatLive ? 'Unlink' : 'Link', () => assignChat(name, chatLive)),
    );

    // Manual label
    const secT = section('Manual type label', 'fa-tag');
    const sel = document.createElement('select');
    sel.className = 'text_pole';
    sel.append(new Option('(none)', ''));
    for (const [v, label] of [['persona', 'Persona'], ['character', 'Character'], ['chat', 'Chat']]) {
        sel.append(new Option(label, v));
    }
    sel.value = manualType(name) ?? '';
    sel.addEventListener('change', () => setType(name, sel.value || null));
    secT.appendChild(sel);

    // Cover
    const secC = section('Cover image', 'fa-image');
    const hasCover = !!getSettings().covers[name];
    const wrap = document.createElement('div');
    wrap.className = 'wig-bp-setting-row';
    const setB = mkPopupBtn('fa-upload', 'Upload…', () => pickCover(name));
    const rmB = mkPopupBtn('fa-eraser', 'Remove', () => { delete getSettings().covers[name]; saveSettings(); renderGallery(); renderPopupHead(); });
    rmB.style.opacity = hasCover ? '' : '0.4';
    wrap.append(setB, rmB);
    secC.appendChild(wrap);

    // Folders / Lorebook Manager
    const secF = section('Folders & compatibility', 'fa-folder-tree');
    const info = bookCache.get(name);
    const note = document.createElement('div');
    note.className = 'wig-bp-note';
    note.textContent = info
        ? `${info.folders.size} folder(s). Folders are stored inside the lorebook (entry field "extensions.${LM_FOLDER_FIELD}") and are compatible with Lorebook Manager.`
        : 'Folders are stored inside the lorebook and are compatible with Lorebook Manager.';
    const imp = mkPopupBtn('fa-file-import', 'Import from Lorebook Manager', async () => {
        const changed = await importFolderData(name);
        getSettings().lmImported[name] = true;
        saveSettings();
        await getBookInfo(name);
        renderPopupHead();
        state.bp?.rerender?.();
        toast(changed ? 'success' : 'info', changed ? `Imported (${changed} entries updated).` : 'Nothing to import — no changes found.');
    });
    secF.append(note, imp);

    // Danger zone
    const secD = section('Danger zone', 'fa-triangle-exclamation');
    const del = mkPopupBtn('fa-trash-can', 'Delete lorebook…', () => deleteBook(name));
    del.classList.add('wig-danger');
    secD.appendChild(del);
}

// ---------------------------------------------------------- native editor folders
function currentBookName() {
    const v = jq('#world_editor_select').val();
    if (v === '' || v === null || v === undefined) return null;
    return state.lastNames[Number(v)] ?? null;
}

function mkBtn(label, icon, onClick) {
    const b = document.createElement('div');
    b.className = 'menu_button wig-mini-btn';
    const i = document.createElement('i');
    i.className = 'fa-solid ' + icon;
    b.appendChild(i);
    if (label) {
        const s = document.createElement('span');
        s.textContent = label;
        b.appendChild(s);
    }
    b.addEventListener('click', onClick);
    return b;
}

function updateMoveUi() {
    const wrap = document.getElementById('wig-folder-actions');
    if (!wrap) return;
    wrap.replaceChildren();
    if (state.selectMode) {
        const n = state.selection.size;
        const cnt = document.createElement('span');
        cnt.className = 'text_pole';
        cnt.textContent = `${n} selected`;
        const move = mkBtn('Move to…', 'fa-folder-plus', () => folderPickerNative(currentBookName(), [...state.selection]));
        move.style.opacity = n ? '' : '.4';
        const cancel = mkBtn('Cancel', 'fa-xmark', () => enterSelectMode(false));
        wrap.append(cnt, move, cancel);
    } else {
        wrap.append(mkBtn('Move entries', 'fa-hand-pointer', () => enterSelectMode(true)));
    }
}

function enterSelectMode(on) {
    state.selectMode = on;
    if (!on) {
        state.selection.clear();
        $$('.world_entry.wig-selected').forEach((el) => el.classList.remove('wig-selected'));
    }
    updateMoveUi();
}

async function folderPickerNative(book, uids) {
    if (!book || !uids.length) return;
    const info = await getBookInfo(book);
    const items = orderedFolders(book, new Set(info.folders.keys())).map((f) => ({
        icon: 'fa-folder', label: f, action: () => moveEntries(book, uids, f),
    }));
    items.push({ type: 'divider' });
    items.push({
        icon: 'fa-folder-plus', label: 'New folder…',
        action: async () => {
            const name = await ctx.Popup.show.input('New folder', 'Folder name:', '');
            const f = String(name ?? '').trim();
            if (!f || RESERVED.has(f.toLowerCase())) { if (f) toast('warning', 'Invalid folder name.'); return; }
            const order = getSettings().folderOrder[book] ?? [];
            if (!order.includes(f)) order.push(f);
            getSettings().folderOrder[book] = order;
            saveSettings();
            await moveEntries(book, uids, f);
        },
    });
    items.push({ type: 'divider' });
    items.push({
        icon: 'fa-book',
        label: 'Send to another book…',
        action: () => sendToBookMenu(book, uids, document.getElementById('wig-folder-actions')),
    });
    items.push({ icon: 'fa-xmark', label: 'Remove from folder', danger: true, action: () => moveEntries(book, uids, null) });
    showMenu(items, document.getElementById('wig-folder-actions'));
}

async function refreshFolderBar() {
    const bar = document.getElementById('wig-folder-bar');
    if (!bar) return;
    const book = currentBookName();
    if (!book || state.view !== 'editor') { bar.style.display = 'none'; return; }
    const info = await getBookInfo(book);
    const folderNames = new Set([...info.folders.keys(), ...(getSettings().folderOrder[book] ?? [])]);
    const folders = orderedFolders(book, folderNames);
    bar.style.display = folders.length ? '' : 'none';

    const chips = document.getElementById('wig-folder-chips');
    chips.replaceChildren();
    const active = state.folderFilter[book] ?? '*';
    const mk = (val, label, count) => {
        const c = document.createElement('div');
        c.className = 'wig-chip' + (active === val ? ' active' : '');
        c.textContent = `${label} (${count})`;
        c.addEventListener('click', () => { state.folderFilter[book] = val; refreshFolderBar(); applyFolderFilter(); });
        chips.appendChild(c);
    };
    mk('*', 'All', info.count);
    mk(UNSORTED, 'Ungrouped', info.count - [...info.folders.values()].reduce((a, b) => a + b, 0));
    for (const f of folders) mk(f, f, info.folders.get(f) ?? 0);
    updateMoveUi();
}

async function applyFolderFilter() {
    const book = currentBookName();
    if (!book) return;
    const active = state.folderFilter[book] ?? '*';
    // Use the cached per-uid folder map when the book cache is warm; only
    // fetch when it was invalidated (a real book change — WORLDINFO_UPDATED
    // clears it). This used to load the book from the server on EVERY call,
    // and it's called on every settings/world-info event in editor view.
    let map;
    if (bookCache.has(book)) map = bookCache.get(book).uidFolder;
    else map = (await getBookInfo(book)).uidFolder;
    for (const el of $$('#world_popup_entries_list .world_entry')) {
        const uid = Number(el.getAttribute('uid'));
        const folder = map.get(uid) ?? null;
        if (el.dataset.wigFolder !== (folder ?? '')) {
            if (folder !== null) el.dataset.wigFolder = folder;
            else delete el.dataset.wigFolder;
        }
        const show = active === '*' || (active === UNSORTED ? folder === null : folder === active);
        if (!show) { el.dataset.wigHidden = '1'; el.style.display = 'none'; }
        else if (el.dataset.wigHidden) { el.style.display = ''; delete el.dataset.wigHidden; }
    }
}

// ---------------------------------------------------------- rename migration
async function migrateRenames(names) {
    const s = getSettings();
    if (!names.length) return; // a transient empty book list must not look like "every book was deleted"
    const added = names.filter((n) => !state.lastNames.includes(n));
    const removed = state.lastNames.filter((n) => !names.includes(n));
    let dirty = false;
    if (added.length === 1 && removed.length === 1) {
        const [from, to] = [removed[0], added[0]];
        for (const key of ['covers', 'types', 'folderOrder', 'lmImported', 'chatBindings']) {
            if (s[key]?.[from] !== undefined) {
                if (s[key][to] === undefined) s[key][to] = s[key][from];
                delete s[key][from];
                dirty = true;
            }
        }
        if (s.collapsedFolders?.[from]) {
            s.collapsedFolders[to] = s.collapsedFolders[from];
            delete s.collapsedFolders[from];
            dirty = true;
        }
        if (state.folderFilter[from] !== undefined) { state.folderFilter[to] = state.folderFilter[from]; delete state.folderFilter[from]; }
    } else if (removed.length) {
        for (const n of removed) {
            delete s.covers[n]; delete s.types[n]; delete s.folderOrder[n]; delete s.lmImported[n]; delete s.chatBindings[n];
            delete s.collapsedFolders[n]; delete state.folderFilter[n];
        }
        dirty = true;
    }
    if (dirty) saveSettings();
}

// ---------------------------------------------------------- global reactions
const onBooksChanged = debounce(async () => {
    noteChatBindings(); // reconcile remembered chat links with the live chat
    const names = (await ctx.getWorldInfoNames()) ?? [];
    await migrateRenames(names);
    state.lastNames = names;
    // No blanket cache invalidation here: unrelated events (the constant
    // SETTINGS_UPDATED some extensions emit among them) used to wipe the
    // book cache and re-fetch every lorebook from the server each time.
    // Book-content changes arrive via WORLDINFO_UPDATED, which invalidates.
    if (state.view === 'gallery') renderGallery();
    else { refreshFolderBar(); applyFolderFilter(); }
    if (state.bp) {
        if (!names.includes(state.bp.name)) await closeBookPopup(true);
        else {
            await getBookInfo(state.bp.name);
            renderPopupHead();
            state.bp.rerender?.();
        }
    }
}, 400);

function onEv(name, fn) {
    const type = ET[name];
    if (type) ctx.eventSource.on(type, fn);
}

// ---------------------------------------------------------- WI drawer watching
// Reopening the World Info panel should return to the gallery (when it's the
// default view). The old implementation bound a click handler to
// '#WorldInfoToggle' — but current ST opens the panel via the top-bar icon
// '#WIDrawerIcon' (the UI perf refactor reworked the toggle flow), so the
// handler bound to nothing (jQuery .on() on an empty set is a silent no-op)
// and reopening kept whatever view was last active. Watch the drawer itself
// instead: open/close state is class-managed on the drawer wrapper
// ('.openDrawer' / '.closedDrawer'), so a MutationObserver catches every
// open path — top-bar icon, inline handle, programmatic, extension-driven.
function wiDrawerState() {
    const content = document.getElementById('WorldInfo');
    const wrap = content?.closest('.drawer') ?? content?.parentElement ?? null;
    const isOpen = () => {
        if (wrap?.classList.contains('openDrawer') || wrap?.classList.contains('closedDrawer')) {
            return wrap.classList.contains('openDrawer'); // class-managed state (current ST)
        }
        return jq(content).is(':visible'); // display-based state (older builds)
    };
    return { content, wrap, isOpen };
}

// Runs on every hidden → visible transition of the WI drawer.
function onDrawerOpened() {
    // ST's WI perf refactor destroys the expandable editor ~1s after the
    // drawer hides and rebuilds it on reopen — our folder bar, entries-list
    // listeners, and (worst case) gallery can go with it. Restore anything
    // missing before applying the default view.
    if (!document.getElementById('wig-editor-bar')) injectHeaderButtons();
    if (!document.getElementById('wig-gallery')) { injectGallery(); lastGallerySig = null; }
    if (!document.getElementById('wig-folder-bar')) injectFolderBar();
    wireEntriesList();
    if (getSettings().galleryDefault && state.view !== 'gallery') setView('gallery');
}

function wireDrawerWatcher() {
    const { content, wrap, isOpen } = wiDrawerState();
    if (!content) { console.warn(`[${MODULE_NAME}] WI drawer not found — reopen handling disabled.`); return; }
    let open = isOpen();
    const checkNow = () => {
        const nowOpen = isOpen();
        if (nowOpen && !open) onDrawerOpened();
        open = nowOpen;
    };
    const check = debounce(checkNow, 150);
    const mo = new MutationObserver(check);
    for (const t of [wrap, content]) if (t) mo.observe(t, { attributes: true, attributeFilter: ['class', 'style'] });
    // Click fallback for open paths the observer might miss (unusual markup)
    jq('#WIDrawerIcon, #WorldInfoToggle').on('click', () => setTimeout(checkNow, 250));
}

// The native entries list can be torn down and rebuilt by ST itself (editor
// reloads), and every rebuild resets the drawer's scroll to the top — long
// lorebooks become unusable when rebuilds happen often. Mirror the gallery's
// keepscroll: remember the scroller's position on real scrolls, and restore
// it whenever a rebuild removes entries — no matter who triggered it. The
// memory is per-book, so deliberately switching books still starts at top.
let wiredEntriesListEl = null;
let entriesListObserver = null;
let editorScrollEl = null;
let editorScrollMem = { el: null, top: 0, book: null };
let pendingScrollRestore = 0;
const applyFilterDebounced = debounce(() => { if (state.view === 'editor') applyFolderFilter(); }, 150);

function onEditorScroll() {
    if (state.view !== 'editor' || !editorScrollEl) return;
    editorScrollMem = { el: editorScrollEl, top: editorScrollEl.scrollTop, book: currentBookName() };
}

function tryRestoreEditorScroll() {
    if (!pendingScrollRestore) return;
    if (Date.now() > pendingScrollRestore) { pendingScrollRestore = 0; return; }
    const list = document.getElementById('world_popup_entries_list');
    if (!list?.querySelector('.world_entry')) return; // mid-teardown; the next mutation tick retries
    pendingScrollRestore = 0;
    const scroller = scrollParentOf(list);
    // Same scroller AND same book as the remembered position — otherwise the
    // rebuild was a deliberate book switch, which should start at the top.
    if (scroller && scroller === editorScrollMem.el && editorScrollMem.book === currentBookName()) {
        scroller.scrollTop = editorScrollMem.top;
    }
}

function wireEntriesList() {
    const list = document.getElementById('world_popup_entries_list');
    if (!list || wiredEntriesListEl === list) return;
    wiredEntriesListEl = list;
    jq(list)
        .off('click.wig contextmenu.wig')
        .on('click.wig', (e) => {
            if (!state.selectMode) return;
            const entry = e.target.closest('.world_entry');
            if (!entry) return;
            e.preventDefault();
            e.stopPropagation();
            const uid = Number(entry.getAttribute('uid'));
            if (state.selection.has(uid)) { state.selection.delete(uid); entry.classList.remove('wig-selected'); }
            else { state.selection.add(uid); entry.classList.add('wig-selected'); }
            updateMoveUi();
        })
        .on('contextmenu.wig', (e) => {
            if (state.selectMode) return;
            const entry = e.target.closest('.world_entry');
            if (!entry || !currentBookName()) return;
            e.preventDefault();
            e.stopPropagation();
            folderPickerNative(currentBookName(), [Number(entry.getAttribute('uid'))]);
        });
    // Scroll memory: bind to whatever ancestor actually scrolls (the drawer
    // content). No height requirement, so the listener exists before the
    // book is tall enough to scroll.
    let scroller = null;
    for (let p = list.parentElement; p && p !== document.body; p = p.parentElement) {
        if (['auto', 'scroll', 'overlay'].includes(getComputedStyle(p).overflowY)) { scroller = p; break; }
    }
    if (scroller && scroller !== editorScrollEl) {
        editorScrollEl?.removeEventListener('scroll', onEditorScroll);
        editorScrollEl = scroller;
        scroller.addEventListener('scroll', onEditorScroll, { passive: true });
    }
    entriesListObserver?.disconnect();
    entriesListObserver = new MutationObserver((muts) => {
        if (state.view !== 'editor') return;
        // ST replaced the list element wholesale (rare) → rebind everything
        if (document.getElementById('world_popup_entries_list') !== wiredEntriesListEl) {
            wireEntriesList();
            pendingScrollRestore = Date.now() + 750;
            if (!document.getElementById('wig-folder-bar')) injectFolderBar();
            refreshFolderBar();
        }
        const tornDown = muts.some((m) => [...m.removedNodes].some(
            (n) => n instanceof Element && (n.classList.contains('world_entry') || !!n.querySelector('.world_entry'))));
        if (tornDown) pendingScrollRestore = Date.now() + 750;
        if (pendingScrollRestore) tryRestoreEditorScroll();
        applyFilterDebounced();
    });
    // Observe the PARENT (subtree) so the observer survives ST replacing the
    // list element itself, not just its children.
    entriesListObserver.observe(list.parentElement ?? list, { childList: true, subtree: true });
}

function wireGlobalListeners() {


    jq('#world_editor_select').on('change', async (e) => {
        // React only to REAL user interaction with the selector. ST fires
        // synthetic change events on it during normal operation —
        // setWorldInfoSettings on init, reloadEditor after programmatic
        // book/entry updates, and the editor refresh that follows a chat
        // lorebook binding save. Treating those as user selections hijacked
        // the gallery into the native editor view ("the UI closed").
        // jQuery-synthesized events carry no originalEvent; user events do.
        if (!e.originalEvent) return;
        await sleep(0);
        const v = jq('#world_editor_select').val();
        const hasBook = v !== '' && v !== null && v !== undefined;
        if (hasBook && state.view !== 'editor') setView('editor');
        else if (!hasBook && state.view !== 'gallery') setView('gallery');
        else { refreshFolderBar(); applyFolderFilter(); }
    });

    // Book contents changed (ours or the native editor's) → drop cached info.
    onEv('WORLDINFO_UPDATED', () => invalidateBooks());
    onEv('WORLDINFO_UPDATED', onBooksChanged);
    onEv('WORLDINFO_SETTINGS_UPDATED', onBooksChanged);
    onEv('SETTINGS_UPDATED', onBooksChanged);
    onEv('CHAT_CHANGED', onBooksChanged);
    onEv('PERSONA_UPDATED', onBooksChanged);
    onEv('PERSONA_CHANGED', onBooksChanged);
    onEv('PERSONA_DELETED', onBooksChanged);
    onEv('CHARACTER_EDITED', onBooksChanged);
    onEv('CHARACTER_LOADED', onBooksChanged);
    // Tokenizer/model changes invalidate token counts (keyed by tokenizerKey)
    onEv('MAIN_API_CHANGED', onBooksChanged);
    onEv('PRESET_CHANGED', onBooksChanged);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.selectMode) enterSelectMode(false);
    });

    wireEntriesList();

    const list = document.getElementById('world_popup_entries_list');
    if (list) {
        new MutationObserver(debounce(() => {
            if (state.view === 'editor') applyFolderFilter();
        }, 150)).observe(list, { childList: true, subtree: true });
    }
}

// ---------------------------------------------------------- UI injection
function injectHeaderButtons() {
    const popup = document.getElementById('world_popup');
    if (!popup || document.getElementById('wig-editor-bar')) return;
    // Current ST has no stable editor-header ID to hook into, so editor view
    // gets its own slim top bar. Hidden automatically in gallery mode by the
    // child-hiding CSS rule.
    const bar = document.createElement('div');
    bar.id = 'wig-editor-bar';
    const back = document.createElement('div');
    back.id = 'wig-back';
    back.className = 'menu_button fa-solid fa-arrow-left';
    back.title = 'Back to gallery';
    back.addEventListener('click', () => setView('gallery'));
    bar.appendChild(back);
    popup.prepend(bar);
}

function injectGallery() {
    if (document.getElementById('wig-gallery')) return;
    const popup = document.getElementById('world_popup');
    if (!popup) { console.warn(`[${MODULE_NAME}] #world_popup not found.`); return; }

    const wrap = document.createElement('div');
    wrap.id = 'wig-gallery';
    wrap.innerHTML = `
        <div id="wig-toolbar">
            <div id="wig-chips"></div>
            <div id="wig-controls">
                <input id="wig-search" class="text_pole" type="text" placeholder="Search…" autocomplete="off">
                <select id="wig-sort" class="text_pole">
                    <option value="name-asc">A → Z</option>
                    <option value="name-desc">Z → A</option>
                    <option value="entries-desc">Entries ↓</option>
                    <option value="tokens-desc">Tokens ↓</option>
                </select>
                <span id="wig-count" class="text_pole"></span>
            </div>
            <div id="wig-actions">
                <div id="wig-open-import" class="menu_button" title="Import lorebook file(s)">
                    <i class="fa-solid fa-file-import"></i><span>Import</span>
                </div>
                <div id="wig-open-editor" class="menu_button" title="Open the native World Info editor">
                    <i class="fa-solid fa-pen-to-square"></i><span>Editor</span>
                </div>
            </div>
        </div>
        <div id="wig-grid"></div>`;
    popup.appendChild(wrap);

    document.getElementById('wig-search').addEventListener('input', debounce((e) => {
        state.search = e.target.value.trim();
        renderGallery();
    }, 200));
    document.getElementById('wig-sort').addEventListener('change', (e) => {
        state.sort = e.target.value;
        renderGallery();
    });
    document.getElementById('wig-open-editor').addEventListener('click', () => setView('editor'));
    document.getElementById('wig-open-import').addEventListener('click', () => importBook());
}

function injectFolderBar() {
    if (document.getElementById('wig-folder-bar')) return;
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return;
    const bar = document.createElement('div');
    bar.id = 'wig-folder-bar';
    bar.style.display = 'none';
    bar.innerHTML = `
        <i class="fa-solid fa-folder-open wig-folder-icon"></i>
        <div id="wig-folder-chips"></div>
        <div id="wig-folder-actions"></div>`;
    list.before(bar);
}

// ---------------------------------------------------------- settings panel
async function initSettingsPanel() {
    let html;
    try {
        html = await ctx.renderExtensionTemplateAsync(EXT_PATH, 'settings');
    } catch (e) {
        // A missing/broken template must never kill the whole extension
        console.warn(`[${MODULE_NAME}] Settings template unavailable — settings panel skipped.`, e);
        return;
    }
    jq('#extensions_settings2').append(html);
    const wire = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!getSettings()[key];
        el.addEventListener('change', () => { getSettings()[key] = el.checked; saveSettings(); });
    };
    wire('wig-opt-default', 'galleryDefault');
    wire('wig-opt-tokens', 'showTokens');
    wire('wig-opt-derive', 'deriveCovers');
	const ph = document.getElementById('wig-opt-placeholder');
    if (ph) {
        ph.value = getSettings().placeholderCover ?? 'letter';
        ph.addEventListener('change', () => {
            getSettings().placeholderCover = ph.value;
            saveSettings();
            renderGallery();
            if (state.bp) renderPopupHead();
        });
    }
	    const scan = document.getElementById('wig-scan-chats');
    if (scan) {
        let scanning = false;
        scan.addEventListener('click', async () => {
            if (scanning) return;
            scanning = true;
            const label = scan.querySelector('span');
            const old = label?.textContent ?? '';
            scan.style.opacity = '0.5';
            if (label) label.textContent = 'Scanning…';
            try {
                const { chats, books } = await scanAllChatBindings();
                toast('success', `Scanned ${chats} chat${chats === 1 ? '' : 's'} — ${books} lorebook${books === 1 ? '' : 's'} chat-linked.`);
            } catch (e) {
                console.error(`[${MODULE_NAME}] chat scan failed`, e);
                toast('error', 'Chat scan failed on this build.');
            } finally {
                scanning = false;
                scan.style.opacity = '';
                if (label) label.textContent = old;
            }
        });
    }
}

// ---------------------------------------------------------- init
async function init() {
    if (!document.getElementById('world_popup')) {
        console.warn(`[${MODULE_NAME}] World Info popup not found — UI not injected.`);
        return;
    }
    await initSettingsPanel();
    injectHeaderButtons();
    injectGallery();
    injectFolderBar();
    wireGlobalListeners();
    wireDrawerWatcher();
    state.lastNames = (await ctx.getWorldInfoNames()) ?? [];
    cfSupportsArrayModel(); // settle character-filter capability before first editor opens
    loadTags();             // prewarm the tags registry
    await loadWiModule();   // live WI settings (charLore / selected_world_info) for badges
    noteChatBindings();     // seed remembered chat links from the restored chat
    setView(getSettings().galleryDefault ? 'gallery' : 'editor');
    console.debug(`[${MODULE_NAME}] initialized`);
}

jQuery(() => { init(); });
