# Extension — Romäntik

MV3 extension (Firefox + Chrome), written in TypeScript and bundled with esbuild. Pairs with the
local FastAPI backend in `../backend/`.

It renders one colour-coded subtitle line in the spoken (Romance) language; hovering a word shows its
translation and grammar in a tooltip. There is no second translated subtitle line.

## Build

```bash
npm install
npm run build              # builds both: dist-firefox/ and dist-chrome/
npm run build:firefox      # only Firefox build
npm run build:chrome       # only Chrome build
npm run watch              # esbuild watch (Firefox target)
npm run dev                # esbuild watch + web-ext run (temporary Firefox profile)
npm run lint               # tsc --noEmit
npm run package:firefox    # zip dist-firefox/ → web-ext-artifacts/
npm run package:chrome     # zip dist-chrome/ → web-ext-artifacts/
```

Each build copies the right manifest (`manifest.firefox.json` or `manifest.chrome.json`) into the
target dist directory along with the bundled JS, HTML, CSS, and the MAIN-world bridge
(`page-fetch.js`).

## Load into Firefox

1. `npm run build:firefox` (or `npm run build`)
2. `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → pick **`dist-firefox/manifest.json`**
4. After any rebuild click **Reload** next to the add-on, then reload the YouTube tab.

## Load into Chrome

1. `npm run build:chrome` (or `npm run build`)
2. `chrome://extensions` → enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → pick the `dist-chrome/` directory
4. After any rebuild click the reload icon on the extension card, then reload the YouTube tab.

Chrome 111+ is required (for `world: "MAIN"` content scripts). Brave, Edge, and other Chromium
browsers based on the same version work too.

## How a YouTube tab is wired

Two content scripts inject on `https://www.youtube.com/*`:

| Script | World | When | Purpose |
| --- | --- | --- | --- |
| `page-fetch.js` | MAIN | `document_start` | Monkey-patches `fetch` + `XMLHttpRequest`. Captures bodies of `api/timedtext` requests (the only way to get a valid `pot`-signed caption URL). Listens for `sr-captions-req` postMessages and returns the captured caption body. |
| `content.js` | ISOLATED | `document_idle` | Reads `ytInitialPlayerResponse` to verify a track for the configured source language exists, asks the bridge for cues, mounts the overlay, syncs to `video.currentTime`, calls `/analyze` per cue, renders the colour-coded tokens, and wires the hover tooltip (word translation + morphology). |

`styles.css` adds the overlay styles, POS colors, tooltip box, and a rule hiding
`.ytp-caption-window-container` so the native caption window doesn't overlap ours.

The toolbar popup is `public/popup.html` (settings form); the options page is `public/options.html`
(spoken language, translated language, backend URL, display toggles). Settings are stored via
`browser.storage.sync`.

## Source layout

```
src/
├── types.ts        Settings, Cue, Token, SOURCE_LANGS, LANGS, RuntimeMessage
├── background.ts   service worker, settings storage + message router
├── content.ts      entry on youtube.com; SPA-aware URL watcher; mounts/destroys overlay; provides the
│                   tooltip's per-word translate function
├── captions.ts     findSourceTrack(sourceLang), requestCues() (postMessage bridge wrapper), JSON3/XML parsing
├── api.ts          POST /analyze (with lang) + POST /translate (per word); in-memory caches
├── overlay.ts      single source line, rAF sync, prefetch next N cues; tokens carry data attributes
├── tooltip.ts      hover tooltip: word + async translation + lemma·POS + morphology
├── settings-form.ts  shared settings form builder
├── settings-panel.ts in-page gear + panel
├── options.ts      options page UI
└── popup.ts        toolbar popup UI

public/
├── options.html
├── popup.html
├── page-fetch.js   plain JS, MAIN-world bridge (not bundled)
└── styles.css      overlay, POS colors, tooltip, hides native YT captions
```

## User flow

1. Backend is running on `http://localhost:8765` with the model for the source language installed.
2. Pick the **Spoken language** and the **Translated language** in the ⚙ panel / options.
3. Open a YouTube video with a caption track in the spoken language.
4. A red banner appears top-right: *"Enable YouTube CC and pick the &lt;language&gt; track to activate Romäntik."*
5. Click YouTube's **CC** button. If multiple subtitle tracks exist, open the gear icon →
   **Subtitles/CC** and select the source-language track.
6. The bridge captures the caption response; the banner disappears and the colour-coded source line
   renders.
7. Hover any word → tooltip with the word, its translation (lemma glossed into the target language),
   the dictionary form + part of speech, and the morphology. Translations are fetched on demand and
   cached, so each word hits the backend at most once.

## Common edits

- **Add a source language**: add it to `SOURCE_LANGS` in `src/types.ts` and add the matching spaCy
  model to `MODELS` in `backend/analyzer.py`.
- **Add a target (translation) language**: add it to `LANGS` in `src/types.ts`.
- **Change overlay colors**: edit the `.sr-verb`, `.sr-noun`, `.sr-adj`, `.sr-pron`, `.sr-num`,
  `.sr-adv` rules in `public/styles.css`.
- **Change overlay position**: use the vertical-position slider, or tweak `#sr-overlay` in
  `public/styles.css`.
- **Translate the surface form instead of the lemma**: change `word = (lemma || surface)` in
  `src/tooltip.ts` (not recommended — inflected forms are often mis-sensed out of context).
- **Increase caption-wait timeout**: change `timeoutMs` in `requestCues()` in `src/captions.ts`.

## Known limitations

- Hover translation is a single-word, single-sense gloss of the lemma. The morphology line gives the
  precise grammatical reading. Multi-sense dictionary definitions (e.g. Wiktionary) would be a future
  addition.
- Requires the user to enable native CC and pick the source-language track. We cannot generate `pot`
  tokens.
- YouTube DOM selectors are not contractual. Most likely to break: `.ytp-subtitles-button`,
  `.ytp-caption-window-container`, `#movie_player`, `ytInitialPlayerResponse`.
- ASR (auto-generated) captions have no punctuation; spaCy's parse is weaker on them.
- The overlay is anchored to the player container; fullscreen works. Mini-player / picture-in-picture
  has not been tested.

## Tests

There are no automated tests yet. The smoke test is "load it, open a video in the source language, see
if the overlay colours and the hover tooltip behave."

> Note: the internal DOM/CSS prefix and the postMessage channel names are still `sr-*` (carried over
> from the project this was forked from). They're internal identifiers — renaming them is cosmetic and
> deliberately avoided to keep the page-bridge contract in `page-fetch.js` and `captions.ts` in sync.
