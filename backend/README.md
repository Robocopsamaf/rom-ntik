# Backend — Romäntik Analyzer

Local FastAPI server that runs spaCy for Romance languages (Spanish, French, Italian, Portuguese,
Romanian). The browser extension sends batches of source-language sentences plus a `lang` code and
receives per-token lemma, POS, morphology (gender, tense, mood, number, person, …), and a CSS color
class. Models load lazily per language on first use.

## Requirements

- Python 3.9 or newer.
- ~250 MB disk per spaCy model you install (5 models ≈ 1 GB if you install them all).

## One-time setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Install the spaCy model(s) for the source languages you'll watch.
# You only need the ones you'll actually use.
python -m spacy download es_core_news_sm   # Spanish
python -m spacy download fr_core_news_sm   # French
python -m spacy download it_core_news_sm   # Italian
python -m spacy download pt_core_news_sm   # Portuguese
python -m spacy download ro_core_news_sm   # Romanian
```

## Run

```bash
./run.sh
# equivalent to:
uvicorn app:app --host 127.0.0.1 --port 8765
```

Default port `8765`. Override with extra args, e.g. `./run.sh --port 9000`. On startup the default
language (`es`) is loaded eagerly; the others load on their first `/analyze` request.

## Endpoints

- `GET /health` → `{"ok": true, "languages": ["es","fr","it","pt","ro"]}`
- `POST /analyze` — request body `{ "sentences": ["..."], "lang": "es" }` (`lang` defaults to `es`),
  response `{ "sentences": [{ "text": "...", "tokens": [...] }] }`.
- `POST /translate` — request body `{ "texts": ["..."], "target": "en", "source": "es" }` (source
  defaults to `es`), response `{ "translations": ["..."] }`. Backed by `deep-translator`'s
  `GoogleTranslator`. The extension calls this to gloss a **single hovered word** (its lemma) into the
  target language. Multiple texts are joined into one request and split back, with a per-item fallback
  on line-count mismatch and exponential backoff on rate-limit errors; empty (failed) translations are
  not cached so they retry later.

Each token:

```json
{
  "surface": "corre",
  "lemma": "correr",
  "pos": "VERB",
  "morph": {"Mood": "Ind", "Tense": "Pres", "Person": "3", "Number": "Sing", "VerbForm": "Fin"},
  "color_class": "verb",
  "is_word": true
}
```

`color_class` is one of `verb`, `noun`, `adj`, `pron`, `num`, `adv`, `other`.

## Smoke test

```bash
curl -s -X POST http://localhost:8765/analyze \
  -H 'Content-Type: application/json' \
  -d '{"lang":"es","sentences":["El gato negro corre rápido."]}' | jq
```

Expect `gato`/`negro` to carry `morph.Gender = "Masc"` and `corre` to carry a verb `Tense`.

## Caching

Each language analyzer memoizes its sentences in an in-process dict (cap 8192, drops oldest ~10% when
full). `/translate` keeps a separate cache keyed by `(source, target, text)` (cap 16k entries); only
successful (non-empty) translations are cached, so a word that failed retries on the next request.

## Tuning

`backend/analyzer.py`:

- `MODELS` maps each source language code to its spaCy model name. Swap `*_sm` for `*_md` / `*_lg`
  for better accuracy at higher memory cost, or add another language (e.g. Catalan `ca_core_news_sm`).
- `POS_COLOR` maps spaCy POS tags to the extension's CSS classes — edit to add categories.

## Troubleshooting

- **`OSError: [E050] Can't find model 'es_core_news_sm'`** — run
  `python -m spacy download es_core_news_sm` (and likewise for the other languages).
- **`400 unsupported source language`** — the requested `lang` isn't in `MODELS`. Add it and install
  the corresponding spaCy model.
- **Port already in use** — pass `--port <N>` to `run.sh` and update the extension's Backend URL.
- **`/translate` returns empty strings** — `deep-translator` scrapes Google Translate web and
  occasionally hits its own rate limit. Rate-limit / transient errors are retried with backoff
  (1s → 3s → 7s); persistent failures are logged with `[translate] failed (…)` and left blank (and
  not cached, so they retry later). If it's persistent, swap to `LibreTranslate`.
