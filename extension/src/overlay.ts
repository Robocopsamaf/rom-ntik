import { AnalyzedSentence, Cue, Settings, Token } from "./types";

export interface OverlayDeps {
  root: HTMLElement;
  video: HTMLVideoElement;
  sourceCues: Cue[];
  settings: Settings;
  analyze: (texts: string[]) => Promise<AnalyzedSentence[]>;
  onAnalyzeError?: (err: unknown) => void;
  onAnalyzeOk?: () => void;
}

export interface Overlay {
  destroy(): void;
  applySettings(s: Settings): void;
}

const PREFETCH_AHEAD = 30;

function findCueIndex(cues: Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = cues[mid];
    if (c.start <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return -1;
  const c = cues[best];
  if (c.start + Math.max(c.dur, 0.1) < t) return -1;
  return best;
}

function tokenToSpan(tok: Token, settings: Settings): HTMLElement {
  const span = document.createElement("span");
  const klass = ["sr-tok"];
  if (settings.showColors && tok.is_word) klass.push(`sr-${tok.color_class}`);
  span.className = klass.join(" ");
  span.textContent = tok.surface;
  if (settings.showTooltips && tok.is_word) {
    span.dataset.morph = JSON.stringify(tok.morph);
    span.dataset.surface = tok.surface;
    span.dataset.lemma = tok.lemma;
    span.dataset.pos = tok.pos;
  }
  return span;
}

const CLOSE_PUNCT = new Set([",", ".", "!", "?", ";", ":", ")", "]", "}", "»", "”", "’", "…"]);
const OPEN_PUNCT = new Set(["(", "[", "{", "«", "“", "‘", "¿", "¡"]);

function renderAnalyzed(target: HTMLElement, sentence: AnalyzedSentence, settings: Settings) {
  target.innerHTML = "";
  const tokens = sentence.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i > 0) {
      const prev = tokens[i - 1];
      const needSpace = !CLOSE_PUNCT.has(tok.surface) && !OPEN_PUNCT.has(prev.surface);
      if (needSpace) target.appendChild(document.createTextNode(" "));
    }
    target.appendChild(tokenToSpan(tok, settings));
  }
}

export function mountOverlay(deps: OverlayDeps): Overlay {
  const { root, video, sourceCues, settings, analyze, onAnalyzeError, onAnalyzeOk } = deps;

  const wrap = document.createElement("div");
  wrap.id = "sr-overlay";
  const pos = Math.max(0, Math.min(100, settings.overlayPosition));
  wrap.style.top = `${pos}%`;
  const srcLine = document.createElement("div");
  srcLine.className = "sr-line sr-ru";
  wrap.appendChild(srcLine);
  root.appendChild(wrap);

  const analyzed = new Map<number, AnalyzedSentence>();
  const pending = new Set<number>();

  async function ensureAnalyzed(indices: number[]) {
    const need: { idx: number; text: string }[] = [];
    for (const i of indices) {
      if (i < 0 || i >= sourceCues.length) continue;
      if (analyzed.has(i) || pending.has(i)) continue;
      pending.add(i);
      need.push({ idx: i, text: sourceCues[i].text });
    }
    if (need.length === 0) return;
    try {
      const result = await analyze(need.map((n) => n.text));
      result.forEach((s, k) => analyzed.set(need[k].idx, s));
      onAnalyzeOk?.();
    } catch (e) {
      console.warn("[romäntik] analyze failed", e);
      onAnalyzeError?.(e);
    } finally {
      need.forEach((n) => pending.delete(n.idx));
    }
  }

  let currentIdx = -2;
  let raf = 0;
  let stopped = false;

  function loop() {
    if (stopped) return;
    raf = requestAnimationFrame(loop);

    // During ads YouTube plays the ad in the SAME <video> element, so
    // currentTime resets toward 0 and we'd wrongly show the video's first cue.
    // #movie_player carries the `ad-showing` class while an ad plays.
    if (root.classList.contains("ad-showing")) {
      if (srcLine.textContent) srcLine.textContent = "";
      currentIdx = -2; // force a re-render once the ad ends
      return;
    }

    const t = video.currentTime;
    const idx = findCueIndex(sourceCues, t);

    if (idx === currentIdx) return;
    currentIdx = idx;
    if (idx < 0) {
      srcLine.textContent = "";
      return;
    }
    const cue = sourceCues[idx];
    const analyzedSentence = analyzed.get(idx);
    if (analyzedSentence) {
      renderAnalyzed(srcLine, analyzedSentence, settings);
    } else {
      srcLine.textContent = cue.text;
      ensureAnalyzed([idx]).then(() => {
        if (currentIdx === idx) {
          const s = analyzed.get(idx);
          if (s) renderAnalyzed(srcLine, s, settings);
        }
      });
    }
    const prefetch: number[] = [];
    for (let k = 1; k <= PREFETCH_AHEAD; k++) prefetch.push(idx + k);
    ensureAnalyzed(prefetch);
  }

  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
      wrap.remove();
    },
    applySettings(s: Settings) {
      const next = Math.max(0, Math.min(100, s.overlayPosition));
      wrap.style.top = `${next}%`;
      Object.assign(settings, s);
      currentIdx = -2;
    },
  };
}
