from __future__ import annotations

import time
from typing import Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from analyzer import DEFAULT_LANG, MODELS, AnalyzedSentence, get_analyzer

app = FastAPI(title="Romäntik Analyzer", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_up() -> None:
    # Eagerly load the default language so the first request is fast; the rest
    # load lazily on first use to keep memory down.
    try:
        get_analyzer(DEFAULT_LANG)
    except Exception as e:  # pragma: no cover - model may not be installed yet
        print(f"[romäntik] warm-up failed for {DEFAULT_LANG}: {type(e).__name__}: {e}", flush=True)


class AnalyzeRequest(BaseModel):
    sentences: List[str]
    lang: str = DEFAULT_LANG


class AnalyzeResponse(BaseModel):
    sentences: List[AnalyzedSentence]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "languages": sorted(MODELS)}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    try:
        analyzer = get_analyzer(req.lang)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return AnalyzeResponse(sentences=analyzer.analyze_many(req.sentences))


class TranslateRequest(BaseModel):
    texts: List[str]
    target: str
    source: str = DEFAULT_LANG


class TranslateResponse(BaseModel):
    translations: List[str]


_TRANSLATE_CACHE: Dict[Tuple[str, str, str], str] = {}
_TRANSLATE_CACHE_LIMIT = 16384


# Google caps a single request around ~5000 chars; stay well under, leaving room
# for the joining newlines.
_MAX_REQUEST_CHARS = 4500

# Google's free endpoint throttles after sustained traffic. Back off and retry
# rather than letting a whole chunk come back blank (which shows as a skipped
# stretch of subtitles). Delays in seconds between attempts.
_RETRY_DELAYS = [1.0, 3.0, 7.0]


def _retryable(exc: Exception) -> bool:
    name = type(exc).__name__
    return name in {"TooManyRequests", "RequestError", "ServerException"}


def _translate_one(translator, text: str) -> Optional[str]:
    """Translate a single string with backoff on rate-limit / transient errors.
    Returns the translation, or None if it ultimately failed (caller decides
    what to do — keep the cue blank rather than crash the batch)."""
    for attempt in range(len(_RETRY_DELAYS) + 1):
        try:
            r = translator.translate(text)
            return r if isinstance(r, str) else ""
        except Exception as e:  # noqa: BLE001 - deep_translator raises various types
            if _retryable(e) and attempt < len(_RETRY_DELAYS):
                time.sleep(_RETRY_DELAYS[attempt])
                continue
            print(f"[translate] failed ({type(e).__name__}): {e}", flush=True)
            return None


def _translate_per_item(translator, texts: List[str]) -> List[str]:
    out: List[str] = []
    for t in texts:
        r = _translate_one(translator, t)
        out.append(r if isinstance(r, str) else "")
    return out


def _translate_chunk(texts: List[str], source: str, target: str) -> List[str]:
    from deep_translator import GoogleTranslator

    translator = GoogleTranslator(source=source, target=target)
    # `translate_batch` issues one HTTP request *per text*, which is painfully
    # slow for a few hundred caption cues. Instead, join the chunk with newlines
    # and translate it in a single request, then split the result back. Google
    # preserves line breaks, but if the line count ever fails to round-trip we
    # fall back to the safe per-item path so cue/timestamp alignment is never off.
    joined = "\n".join(texts)
    raw = _translate_one(translator, joined)
    if raw is None:
        # The single request failed even after backoff (rate-limited / network).
        # Translating each line individually would hammer the same limit and
        # stall, so leave the chunk blank — the source line still shows.
        return [""] * len(texts)
    lines = raw.split("\n")
    if len(lines) == len(texts):
        return lines
    # Request succeeded but Google merged/split lines — re-translate each line on
    # its own so cue alignment is exact.
    print(
        f"[translate] line count mismatch ({len(lines)} != {len(texts)}), per-item fallback",
        flush=True,
    )
    return _translate_per_item(translator, texts)


def _chunk_by_chars(texts: List[str], max_chars: int) -> List[List[str]]:
    """Group consecutive texts into sub-batches whose joined length stays under
    `max_chars` (always at least one text per batch)."""
    batches: List[List[str]] = []
    cur: List[str] = []
    cur_len = 0
    for t in texts:
        add = len(t) + 1  # + newline separator
        if cur and cur_len + add > max_chars:
            batches.append(cur)
            cur, cur_len = [], 0
        cur.append(t)
        cur_len += add
    if cur:
        batches.append(cur)
    return batches


@app.post("/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest) -> TranslateResponse:
    if not req.texts:
        return TranslateResponse(translations=[])
    if not req.target:
        raise HTTPException(status_code=400, detail="target language required")

    out: List[str] = [""] * len(req.texts)
    misses: List[int] = []
    miss_texts: List[str] = []
    for i, t in enumerate(req.texts):
        key = (req.source, req.target, t)
        cached = _TRANSLATE_CACHE.get(key)
        if cached is not None:
            out[i] = cached
        elif not t.strip():
            out[i] = ""
        else:
            misses.append(i)
            miss_texts.append(t)

    if miss_texts:
        # Batch by character budget so each request carries as many cues as fit
        # under Google's per-request limit (one request instead of one per cue).
        translated: List[str] = []
        for piece in _chunk_by_chars(miss_texts, _MAX_REQUEST_CHARS):
            try:
                translated.extend(_translate_chunk(piece, req.source, req.target))
            except Exception as e:
                print(f"[translate] chunk failed: {type(e).__name__}: {e}", flush=True)
                translated.extend([""] * len(piece))
        for idx, src, tr in zip(misses, miss_texts, translated):
            out[idx] = tr
            # Only cache successful (non-empty) translations, so cues that came
            # back blank from a rate-limit get retried on the next request rather
            # than being permanently stuck empty.
            if tr:
                _TRANSLATE_CACHE[(req.source, req.target, src)] = tr
        if len(_TRANSLATE_CACHE) > _TRANSLATE_CACHE_LIMIT:
            drop = len(_TRANSLATE_CACHE) // 10
            for k in list(_TRANSLATE_CACHE.keys())[:drop]:
                _TRANSLATE_CACHE.pop(k, None)

    return TranslateResponse(translations=out)
