# Bug sweep — Romäntik

*Swept 2026-09-18 against `cb5f6de`. Nothing here is fixed yet — this is the work list.*

## Context

Repo is one commit old (`cb5f6de`), no tests, no CI. Every tracked
source file was read (`extension/src/*.ts`, `extension/public/page-fetch.js`, `backend/*.py`, both manifests,
`build.mjs`) and verified each finding — `npx tsc --noEmit` passes clean (exit 0), so nothing here is
a type error; these are runtime/logic defects found by reading plus targeted probes against the
installed `deep_translator` 1.11.4 / spaCy 3.8.14 in `backend/.venv` and against MDN browser-compat
data.

Outcome: 12 confirmed defects, listed in severity order. Several are *silent* failures (blank output,
no error) which is why they survived the first commit.

---

## Confirmed bugs

### P0 — feature is dead on arrival

**1. Firefox build can never capture captions on its stated minimum version.**
`extension/manifest.firefox.json:9` declares `strict_min_version: "115.0"`, but
`extension/manifest.firefox.json:27` uses `"world": "MAIN"`.

Evidence — MDN browser-compat-data, `webextensions/manifest/content_scripts.json`, `world`:
`chrome: 111`, `firefox: 128`. On Firefox 115–127 `page-fetch.js` never lands in the page world, so
`requestCues` always times out and the user only ever sees the "No captions captured" banner.

Fix: bump `strict_min_version` to `"128.0"`.

**2. Chinese target language always yields an empty gloss.**
`extension/src/types.ts:84` offers `{ code: "zh-Hans", label: "Chinese (Simplified)" }`.
`backend/app.py:111` passes that straight to `GoogleTranslator(source=..., target=...)`.

Evidence (run against `backend/.venv`):
```
>>> GoogleTranslator(source='es', target='zh-Hans')
RAISED LanguageNotSupportedException zh-Hans --> No support for the provided language.
>>> [c for c in GOOGLE_LANGUAGES_TO_CODES.values() if c.startswith('zh')]
['zh-CN', 'zh-TW']
```
The exception is swallowed by the blanket `except Exception` at `backend/app.py:182`, so the tooltip
silently shows `—` forever.

Fix: change the code in `SOURCE`/`LANGS` to `zh-CN` (deep-translator's own spelling). Guard: reject
unknown targets in `/translate` with a 400 instead of returning blanks, so the next such mismatch is
loud.

---

### P1 — visibly wrong output

**3. Tooltips, gear and settings panel are invisible in fullscreen.**
`tooltip.ts:46`, `settings-panel.ts:62,66` and `content.ts:104` all `document.body.appendChild(...)`.
In fullscreen only the fullscreen element's subtree renders, and YouTube fullscreens `#movie_player`.
The subtitle overlay itself is fine (`content.ts:85` mounts into `playerRoot`), so the symptom is:
subtitles show, hovering a word does nothing — the core feature of the extension.

Fix: mount tooltip/gear/panel/banner into the current fullscreen element. Add a
`fullscreenchange` listener that re-parents them to `document.fullscreenElement ?? document.body`.

**4. Elided and hyphenated words get no colour and no tooltip.**
`backend/analyzer.py:103` sets `is_word=tok.is_alpha`; `overlay.ts:43,46` gate both the colour class
and the `data-morph` dataset on `tok.is_word`.

Evidence (`fr_core_news_sm`, sentence `Je n'ai pas dit qu'il aujourd'hui`):
```
"n'"          ADV   is_alpha=False
"qu'"         SCONJ is_alpha=False
"aujourd'hui" ADV   is_alpha=False
```
So in French (and Italian `l'`, `dell'`, `un'`) a large share of function words is inert. Same probe
on Spanish shows `25` NUM `is_alpha=False` — which is why `.sr-num` at `styles.css:61` is defined but
can never match.

Fix: derive `is_word` from POS instead of `is_alpha`, e.g. `tok.pos_ not in {"PUNCT", "SYM", "SPACE"}`
— that keeps punctuation inert while restoring elisions and numerals.

**5. Token spacing is rebuilt with a punctuation heuristic and gets it wrong.**
`overlay.ts:55-69` re-inserts spaces using `CLOSE_PUNCT`/`OPEN_PUNCT` sets. Neither set contains `'`,
so French `n'` + `ai` renders as `n' ai`; `...` (three dots, what spaCy actually emits — only the
single glyph `…` is in `CLOSE_PUNCT`) renders as `casa ...`; `—Sí` renders as `— Sí`.

Fix: stop guessing. spaCy already knows the answer — add `space: bool` to the `Token` model in
`backend/analyzer.py:33` from `bool(tok.whitespace_)`, mirror it in `extension/src/types.ts:27`, and
in `renderAnalyzed` append `" "` iff the *previous* token's `space` is true. Delete both punctuation
sets.

**6. Concurrent `setup()` runs race; the loser wins.**
`content.ts:49-94` has no generation guard, and it awaits `findSourceTrack` (up to ~5s,
`captions.ts:36`) then `requestCues` (up to 125s, `captions.ts:131,138`). Two quick SPA navigations
start two `setup()` calls; whichever resolves *last* overwrites the `overlay` global at
`content.ts:85`. If that is the older video, the newer overlay is leaked (never destroyed, its
`requestAnimationFrame` loop at `overlay.ts:152` keeps running) and stale subtitles are shown.

Fix: module-level `let setupSeq = 0`; capture `const seq = ++setupSeq` at the top of `setup()`, and
bail after every `await` if `seq !== setupSeq`.

**7. Leaving a watch page never tears the overlay down.**
`content.ts:117` returns early on `if (!id) return;` *without* destroying the overlay or resetting
`lastVideoId`. Two consequences: (a) the overlay stays mounted in `#movie_player`, which YouTube
reuses for the home-page inline preview, so cues from the previous video play over an unrelated clip;
(b) returning to the same video id then hits `id === lastVideoId` at `content.ts:118` and never
re-runs setup.

Fix: in the `!id` branch, `overlay?.destroy(); overlay = null; hideBanner(); lastVideoId = null;`
before returning.

---

### P2 — robustness

**8. XML entity decoding is ordered wrong.**
`captions.ts:98-105` replaces `&amp;` → `&` *first*, then `&lt;`, `&gt;`, `&quot;`, `&#39;`. YouTube's
timedtext XML is double-encoded, so `&amp;lt;` decodes to `<` instead of the literal `&lt;`.

Fix: move the `&amp;` replacement to the end of the chain (standard ordering).

**9. `PatchedXHR` breaks on non-text `responseType`, and drops the static constants.**
`page-fetch.js:65-73`. `xhr.responseText` throws `InvalidStateError` per spec whenever `responseType`
is anything but `""`/`"text"`, and the access at line 67 is unguarded inside a `load` listener.
Separately, `PatchedXHR.prototype = OrigXHR.prototype` (line 72) carries the instance constants but
not the statics, so page code reading `XMLHttpRequest.DONE` gets `undefined`.

Fix: wrap the `responseText` read in `try/catch` and skip unless
`xhr.responseType === "" || xhr.responseType === "text"`; copy `UNSENT/OPENED/HEADERS_RECEIVED/
LOADING/DONE` onto `PatchedXHR`.

**10. The fetch patch misses `URL` and `Request`-like inputs.**
`page-fetch.js:38`: `typeof input === "string" ? input : input && input.url`. A `URL` object has no
`.url`, so such a call is not intercepted.

Fix: `const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input?.url);`

**11. The caption response listener accepts messages from any frame.**
`captions.ts:139-147` checks `d.type` and `d.id` but not `ev.source === window` — the mirror of the
check `page-fetch.js:118` already does in the other direction. Any same-page iframe can inject a
caption body.

Fix: add `if (ev.source !== window) return;` as the first line of `handler`.

**12. A short `/analyze` response poisons the client cache permanently.**
`backend/analyzer.py:92` returns `[r for r in results if r is not None]`, silently dropping entries
rather than failing — so a response can be shorter than the request. `api.ts:71` then does
`texts.map((t) => cache.get(...)!)` and hands back `undefined` holes; `overlay.ts:98` stores those
with `analyzed.set(idx, undefined)`, after which `analyzed.has(i)` at `overlay.ts:91` is true forever
and that cue is never re-requested and never rendered with colour.

Fix: in `analyzer.py`, return `results` with an assertion that no entry is `None` (alignment is
guaranteed by construction, so this is a real invariant, not a filter). In `api.ts`, only cache
entries for which the backend actually returned a sentence, and in `overlay.ts` skip `undefined`
results instead of storing them.

---

## Also worth doing (cheap, same pass)

- `content.ts:18-21` reimplements `getSettings` without the `DEFAULT_SETTINGS` merge that
  `settings-form.ts:4-7` already does. Import the existing one and delete the local copy.
- `content.ts:126-135` runs a `MutationObserver` over the whole `document.body` subtree just to poll
  `location.href`. YouTube fires `yt-navigate-finish`; listen for that and keep the observer only as a
  fallback.
- `settings-panel.ts:51` is `async` but called un-awaited at `content.ts:154`, so a gear click before
  `rebuild()` resolves silently no-ops (`toggle()` returns at line 40). Build the panel synchronously
  and fill the form when it resolves.
- `activeTab` is declared in both manifests and never used — drop it.
- `backend/app.py:22` uses `@app.on_event("startup")`, deprecated in FastAPI 0.115.4. Move to the
  `lifespan` context manager.

## Not bugs (checked, leaving alone)

- `translateBatch`'s multi-text batching (`api.ts:15`) and the `tr`/`tlang` path in `captions.ts` and
  `page-fetch.js` look dead, but `readme.md:9` and `DEVELOPMENT.md:109` state single-line-by-design
  with per-word hover translation is intentional. Keeping the batch path costs nothing.
- `http://localhost` fetches from an `https://` page are *not* mixed-content-blocked — both Chrome and
  Firefox treat `localhost`/`127.0.0.1` as potentially trustworthy.
- `allow_origins=["*"]` (`backend/app.py:16`) lets any site probe the backend, but it binds
  `127.0.0.1` only (`backend/run.sh:4`) and serves no secrets. Fine for a local dev tool.

---

## Verification

No test suite exists. Add one for the parts that are pure functions, and verify the rest by hand.

1. **Type + build gate** — `cd extension && npx tsc --noEmit && npm run build`. Must stay exit 0.
2. **Backend unit checks** — add `backend/test_analyzer.py` (pytest):
   - `is_word` covers `n'`, `qu'`, `aujourd'hui`, `25`, and excludes `.`/`¿` (bug 4).
   - `space` round-trips: joining `surface` + `" " if space` reproduces the input sentence exactly for
     a French elision sentence and a Spanish `...`/`—` sentence (bug 5).
   - `analyze_many(["a", "a", "b"])` returns 3 aligned entries (bug 12).
   - `/translate` with `target="zz"` returns 400, with `target="zh-CN"` returns a non-empty string
     (bug 2, needs network — mark `@pytest.mark.network`).
3. **Frontend unit checks** — no runner yet; add `vitest` and cover the pure functions:
   `parseXml` on `&amp;lt;` (bug 8), `parseJson3`, `findCueIndex` boundaries, and `renderAnalyzed`
   spacing against the fixtures from step 2.
4. **Manual, Firefox 128+** — `cd extension && npm run dev`, backend up via `backend/run.sh`:
   - Spanish video with manual CC → colour-coded line appears; hover shows gloss + morphology.
   - Press `f` for fullscreen → tooltip and gear still work (bug 3).
   - French video → hover `qu'`/`aujourd'hui` → tooltip appears; line reads `n'ai`, not `n' ai`
     (bugs 4, 5).
   - watch → home → same watch URL → overlay tears down on home and rebuilds on return (bug 7).
   - Click through three videos fast → exactly one overlay, correct cues (bug 6); confirm only one
     rAF loop by checking no stale `#sr-overlay` remains in the DOM.
   - Set target to Chinese (Simplified) → hover yields Chinese, not `—` (bug 2).
   - Stop the backend mid-video → banner appears; restart → banner clears on the next cue.
5. **Firefox 115 regression** — load the built add-on in an FF 115 profile and confirm it now refuses
   to install rather than installing and silently never capturing captions (bug 1).
