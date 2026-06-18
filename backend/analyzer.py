from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel


# Source language code -> spaCy model name. Lazy-loaded on first use so a setup
# that only ever sees Spanish never pays to load the French/Italian/etc. models.
MODELS: Dict[str, str] = {
    "es": "es_core_news_sm",
    "fr": "fr_core_news_sm",
    "it": "it_core_news_sm",
    "pt": "pt_core_news_sm",
    "ro": "ro_core_news_sm",
}

DEFAULT_LANG = "es"

POS_COLOR = {
    "VERB": "verb",
    "AUX": "verb",
    "NOUN": "noun",
    "PROPN": "noun",
    "ADJ": "adj",
    "PRON": "pron",
    "DET": "pron",
    "NUM": "num",
    "ADV": "adv",
}


class Token(BaseModel):
    surface: str
    lemma: str
    pos: str
    morph: Dict[str, str]
    color_class: str
    is_word: bool


class AnalyzedSentence(BaseModel):
    text: str
    tokens: List[Token]


# Sentinel separator: rare unicode char that spaCy tokenises as a single PUNCT
# token so we can split a merged document back into per-input chunks. Joining
# cues into one doc gives the parser context across cue boundaries (matters a
# lot for ASR captions which have no punctuation or sentence boundaries).
_SEP = " ‖ "
_SEP_TOKEN = "‖"


class Analyzer:
    """spaCy wrapper for a single source language with its own result cache."""

    _CACHE_LIMIT = 8192

    def __init__(self, lang: str, model_name: str) -> None:
        import spacy

        self.lang = lang
        self.nlp = spacy.load(model_name)
        self._cache: Dict[str, AnalyzedSentence] = {}

    def _store(self, text: str, value: AnalyzedSentence) -> None:
        if len(self._cache) > self._CACHE_LIMIT:
            # Drop oldest ~10% (insertion-order). Cheap and good enough.
            drop = len(self._cache) // 10
            for key in list(self._cache.keys())[:drop]:
                self._cache.pop(key, None)
        self._cache[text] = value

    def analyze_many(self, sentences: List[str]) -> List[AnalyzedSentence]:
        # Use cached results for any sentence we've seen; group the misses and
        # send them through spaCy as one document for cross-cue context.
        results: List[Optional[AnalyzedSentence]] = [None] * len(sentences)
        missing: List[int] = []
        for i, s in enumerate(sentences):
            cached = self._cache.get(s)
            if cached is not None:
                results[i] = cached
            else:
                missing.append(i)
        if missing:
            batch = [sentences[i] for i in missing]
            fresh = self._analyze_batch(batch)
            for k, idx in enumerate(missing):
                self._store(sentences[idx], fresh[k])
                results[idx] = fresh[k]
        return [r for r in results if r is not None]

    def _token(self, tok) -> Token:
        pos = tok.pos_
        morph: Dict[str, str] = {k: v for k, v in tok.morph.to_dict().items()} if tok.morph else {}
        return Token(
            surface=tok.text,
            lemma=tok.lemma_,
            pos=pos,
            morph=morph,
            color_class=POS_COLOR.get(pos, "other"),
            is_word=tok.is_alpha,
        )

    def _analyze_batch(self, sentences: List[str]) -> List[AnalyzedSentence]:
        if not sentences:
            return []

        joined = _SEP.join(sentences)
        doc = self.nlp(joined)

        chunks: List[List[Token]] = [[]]
        for tok in doc:
            if tok.text == _SEP_TOKEN:
                chunks.append([])
                continue
            chunks[-1].append(self._token(tok))

        # Ensure exactly one chunk per input. If spaCy ever merges or splits an
        # unexpected number of separators, fall back to per-sentence analysis.
        if len(chunks) != len(sentences):
            return [self._analyze_single(s) for s in sentences]

        return [
            AnalyzedSentence(text=sentences[i], tokens=chunks[i])
            for i in range(len(sentences))
        ]

    def _analyze_single(self, sentence: str) -> AnalyzedSentence:
        doc = self.nlp(sentence)
        return AnalyzedSentence(text=sentence, tokens=[self._token(tok) for tok in doc])


# Lazy per-language registry.
_ANALYZERS: Dict[str, Analyzer] = {}


def get_analyzer(lang: str) -> Analyzer:
    lang = (lang or DEFAULT_LANG).lower()
    if lang not in MODELS:
        raise ValueError(f"unsupported source language: {lang!r} (have {sorted(MODELS)})")
    existing = _ANALYZERS.get(lang)
    if existing is None:
        existing = Analyzer(lang, MODELS[lang])
        _ANALYZERS[lang] = existing
    return existing
