# Development

Two parts: a local Python backend (FastAPI + spaCy) and an MV3 browser extension (TypeScript, bundled
with esbuild) that runs in both Firefox and Chromium-based browsers (Chrome, Edge, Brave).

The extension renders a single colour-coded subtitle line in the spoken (Romance) language. Hovering a
word shows its translation + grammar in a tooltip — there is no second translated subtitle line.

## 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# install the spaCy model(s) for the language(s) you'll watch:
python -m spacy download es_core_news_sm   # and/or fr_/it_/pt_/ro_core_news_sm
./run.sh
```

The server listens on `http://127.0.0.1:8765`. The default language (`es`) loads on startup; the
others load lazily on their first request. Smoke test:

```bash
curl -s -X POST http://localhost:8765/analyze \
  -H 'Content-Type: application/json' \
  -d '{"lang":"es","sentences":["El gato negro corre rápido."]}' | jq
```

Each token carries `surface`, `lemma`, `pos`, `morph` (e.g. `Gender`, `Tense`, `Mood`, `Number`,
`Person`, `VerbForm`), `color_class`, and `is_word`.

> spaCy 3.8.x is required on Python 3.13 (it ships the cp313 wheels). The pin is
> `spacy>=3.8.2,<3.9`.

## 2. Extension

```bash
cd extension
npm install
npm run build              # builds both dist-firefox/ and dist-chrome/
npm run build:firefox      # only Firefox build
npm run build:chrome       # only Chrome build
npm run watch              # esbuild watch (Firefox)
npm run dev                # esbuild watch + web-ext run (spawns Firefox profile)
npm run lint               # tsc --noEmit
```

Two manifests live at the root of the extension: `manifest.firefox.json` (uses `background.scripts` +
`browser_specific_settings.gecko`) and `manifest.chrome.json` (uses `background.service_worker`). The
build script copies the right one into `dist-firefox/` or `dist-chrome/` alongside the bundled JS,
HTML, CSS, and the MAIN-world bridge (`page-fetch.js`).

All extension code uses `webextension-polyfill`, so `browser.*` returns Promises in both browsers
without per-browser shims.

### Load in Firefox

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/dist-firefox/manifest.json`
3. The add-on is removed when Firefox restarts; just reload it.

### Load in Chrome (or Edge / Brave)

1. `chrome://extensions` → toggle **Developer mode** on (top-right).
2. **Load unpacked** → pick the `extension/dist-chrome/` directory.
3. The extension persists across restarts but disappears if you remove it manually.

Chrome 111+ is required (for `world: "MAIN"` content scripts).

After editing TypeScript or any file under `extension/public/`, run `npm run build` (or the
per-browser variant), click **Reload** next to the add-on in `about:debugging` / `chrome://extensions`,
then reload the YouTube tab. Backend-only changes don't need an extension reload — just restart the
server and reload the tab.

## 3. End-to-end smoke test

1. Backend running on `:8765` with the model for your source language installed.
2. Extension loaded.
3. In the in-page ⚙ panel (or Options), set **Spoken language** (e.g. Spanish) and the
   **Translated language** (what hovered words are glossed into).
4. Open a YouTube video that has a caption track in that language.
5. Click YouTube's **CC** button (bottom-right of the player). If the auto-picked track isn't the
   right one, open the gear icon → **Subtitles/CC** → pick the source-language track.
6. The native caption window is hidden by injected CSS; the extension's single overlay line appears
   just above the controls — the source language, POS-coloured.
7. Hover any word → tooltip showing: the word, its translation (the lemma glossed into the target
   language), the dictionary form + POS, and morph fields (Gender, Number, Tense, Mood, Person,
   VerbForm, etc).
8. Change **Spoken language** in settings → the YouTube tab re-runs setup automatically. Changing
   **Translated language** takes effect on the next hover (no reload needed).

If the backend is unreachable a red banner appears in the top-right with instructions; the source
line still renders (without colors/tooltips) so the rest of the page is not broken.

## 4. How the caption capture works

YouTube now requires a session-bound `pot` (proof-of-origin token) on `api/timedtext` requests. The
token is only generated when the user enables CC through the native UI. So the extension does **not**
synthesize caption URLs.

Two content scripts run on `youtube.com/*`:

- `page-fetch.js` runs at `document_start` with `world: "MAIN"`. It monkey-patches `window.fetch` and
  `XMLHttpRequest`. When the patched code sees a request matching `/api/timedtext`, it clones the
  response, reads the body, and stores `{ body, url }` keyed by `lang|tlang`.
- `content.js` (ISOLATED world) parses `ytInitialPlayerResponse` to confirm a track for the configured
  source language exists, then `postMessage`s a `sr-captions-req` to the bridge and waits for the
  captured caption body. (Romäntik requests captions with an empty `tlang`, so no translated track is
  fetched from YouTube — translation is per-word on hover via the backend.)

This is why the user must enable CC manually — we can't sign URLs ourselves.

## 5. Project layout reference

```
extension/
├── manifest.firefox.json    Firefox build manifest (background.scripts + gecko)
├── manifest.chrome.json     Chrome build manifest (background.service_worker)
├── package.json             esbuild, typescript, web-ext, webextension-polyfill
├── build.mjs                --target=firefox|chrome → dist-<target>/
├── tsconfig.json
├── src/
│   ├── types.ts             Settings, Cue, Token, SOURCE_LANGS, LANGS, RuntimeMessage
│   ├── background.ts        service worker, settings storage + message router
│   ├── content.ts           entrypoint on youtube.com; SPA-aware setup/teardown; wires the tooltip's
│   │                        per-word translator
│   ├── captions.ts          findSourceTrack(sourceLang), requestCues() bridge wrapper, JSON3/XML parsing
│   ├── api.ts               POST /analyze (with lang) + POST /translate (per word); caches keyed by
│   │                        lang|sentence and source|target|word
│   ├── overlay.ts           single source line, rAF sync to video.currentTime, prefetch next N cues,
│   │                        per-token spans carrying surface/lemma/pos/morph data attributes
│   ├── tooltip.ts           hover tooltip: word + async translation + lemma·POS + morphology
│   ├── settings-form.ts     shared settings form (source + target language, toggles)
│   ├── settings-panel.ts    in-page gear + panel
│   ├── options.ts           options page logic
│   └── popup.ts             toolbar popup
└── public/
    ├── options.html
    ├── popup.html
    ├── page-fetch.js        MAIN-world bridge (raw JS, copied as-is into dist)
    └── styles.css           overlay, POS colors, tooltip, hides native YT caption window

backend/
├── app.py                   FastAPI app, /health + /analyze (takes lang) + /translate
├── analyzer.py              per-language spaCy registry (lazy), batch alignment, per-language cache
├── requirements.txt         fastapi, uvicorn, pydantic, spacy, deep-translator
├── run.sh                   uvicorn convenience launcher
└── README.md
```

## 6. Translation details

- The tooltip translates the **lemma** (dictionary form), not the inflected surface word. An isolated
  inflected form is frequently mis-sensed by the translator (e.g. French "annoncé" → "announcement"
  instead of the verb "annoncer" → "announce"; "court" → "short" instead of "courir" → "run").
- `/translate` joins multiple texts with newlines into a single request and splits the result back
  (one request instead of one per text), with a per-item fallback if the line count doesn't round-trip,
  and exponential backoff on Google rate-limit errors. For the hover use case it's usually one short
  word per request, but the batching/retry logic is shared.
- Empty (failed) translations are not cached, so they get retried on a later hover.

## 7. Known limitations

- Hover translation is a single-word, single-sense gloss from Google Translate. The morphology line
  gives the precise grammatical reading. Multi-sense dictionary definitions (e.g. Wiktionary) would be
  a future addition.
- YouTube DOM is not contractual. `#movie_player`, `ytInitialPlayerResponse`, and the subtitles button
  class can change without notice.
- Auto-generated (ASR) captions have no punctuation, weakening spaCy's analysis. The batch-join
  (`‖` sentinel) trick in `analyzer.py` gives the parser cross-cue context to compensate.
- The overlay is anchored to `#movie_player`. Fullscreen mode works; some experimental YouTube layouts
  may not.
- Romanian (`ro_core_news_sm`) has thinner morphology coverage than es/fr/it/pt.
