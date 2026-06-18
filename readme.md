# Romäntik

A Firefox + Chrome extension for learning Romance languages from YouTube. It overlays the video with
a single subtitle line in the **spoken** language (Spanish, French, Italian, Portuguese, or Romanian),
colour-coded by part of speech. **Hover any word** to get its translation plus full grammatical
information — dictionary form, part of speech, gender, number, tense, mood, person, verb form — read
straight from spaCy's analysis.

Romäntik shows a single subtitle track — the spoken language — by design. Translation happens on
demand, one word at a time, when you hover, keeping the focus on the language you're learning.

## Architecture

```
┌───────────────────┐   timedtext (intercepted)   ┌────────────────────┐
│  YouTube watch    │ ──────────────────────────► │  Browser extension │
│  page             │                             │  (TypeScript, MV3) │
└───────────────────┘                             └─────────┬──────────┘
                                                            │ POST /analyze   { lang, sentences }   (per cue)
                                                            │ POST /translate { source, target, texts }  (per hovered word)
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ Local FastAPI backend    │
                                              │ spaCy (per-language) +   │
                                              │ deep-translator (Python) │
                                              │ http://localhost:8765    │
                                              └──────────────────────────┘
```

Browsers cannot run spaCy, so a small Python backend (FastAPI) runs locally. The extension finds the
YouTube caption track for the configured source language, captures its cues, and sends each cue to
`/analyze` (with the source `lang`) for per-token POS + morphology, rendered as the colour-coded
overlay. When you hover a word, its **lemma** is sent to `/translate` for a quick gloss in your chosen
target language (cached, so each word is fetched at most once). Each source language maps to its own
spaCy model, loaded lazily on first use.

## Repository layout

```
romäntik/
├── readme.md            ← this file
├── DEVELOPMENT.md       ← full dev setup walkthrough
├── backend/             ← FastAPI + spaCy (es/fr/it/pt/ro)
│   └── README.md        ← backend install & smoke-test
├── extension/           ← MV3 extension (TypeScript) — Firefox + Chrome
│   └── README.md        ← extension build & load
└── .gitignore
```

## Quick start

1. **Backend** (one terminal):

   ```bash
   cd backend
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   # install the model(s) for the language(s) you'll watch:
   python -m spacy download es_core_news_sm   # and/or fr_/it_/pt_/ro_core_news_sm
   ./run.sh                       # http://127.0.0.1:8765
   ```

2. **Extension** (another terminal):

   ```bash
   cd extension
   npm install
   npm run build                  # builds both dist-firefox/ and dist-chrome/
   ```

3. Load extension:

   - **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/dist-firefox/manifest.json`
   - **Chrome** (or Edge / Brave) — `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `extension/dist-chrome/`

4. In the extension options (or the in-page ⚙ panel), pick the **Spoken language** and the language to
   **translate words into**. Open a YouTube video with a caption track in the spoken language, click
   YouTube's **CC** button and select the track (gear icon → Subtitles/CC). The extension intercepts
   the caption fetch, hides the native caption window, renders the colour-coded source line, and you
   can hover any word for its translation and grammar.

Full walkthrough in [DEVELOPMENT.md](DEVELOPMENT.md).

## Configuration

The in-page ⚙ panel or the extension Options page:

- **Spoken language** — the Romance language spoken in the video (Spanish, French, Italian,
  Portuguese, Romanian). Picks the matching caption track and spaCy model.
- **Translated language** — the language hovered words are glossed into.
- **Backend URL** — defaults to `http://localhost:8765`.
- Toggles for POS colors and hover tooltips, plus vertical overlay position.

## Why must the user click YouTube's CC button?

YouTube's caption endpoint now requires a session-bound proof-of-origin token (`pot`) the extension
cannot generate. The native player produces a valid signed URL only when the user enables CC through
its own UI. The extension monkey-patches `fetch`/`XMLHttpRequest` in the page's MAIN world so it can
read the response body once the native player has triggered the request.

## Status

Proof of concept. Personal use only — not on AMO or the Chrome Web Store. Targets Firefox 115+ and
Chromium 111+ (MAIN-world content scripts).

## Stack

- TypeScript, esbuild, `webextension-polyfill`, web-ext (extension)
- Python 3.9+ (3.13 OK), FastAPI, spaCy `{es,fr,it,pt,ro}_core_news_sm`, `deep-translator` (per-word
  Google Translate gloss)

## Known limitations

- Hover translation is a single-word gloss of the lemma (one sense, no context). The morphology line
  gives the precise grammatical reading. Dictionary-quality multi-sense definitions (e.g. Wiktionary)
  would be a future addition.
- Requires the user to enable native CC and pick the source-language track (the `pot` constraint).
- YouTube DOM internals (`#movie_player`, `ytInitialPlayerResponse`, the CC button class) are not
  contractual and can change.
