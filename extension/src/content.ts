import browser from "webextension-polyfill";
import { Settings, SOURCE_LANGS } from "./types";
import { findSourceTrack, requestCues } from "./captions";
import { mountOverlay, Overlay } from "./overlay";
import { analyzeBatch, primeSettings, translateBatch } from "./api";
import { mountTooltip } from "./tooltip";
import { mountSettingsPanel } from "./settings-panel";

console.log("[romäntik] content script loaded", window.location.href);

const STORAGE_KEY = "settings";

let overlay: Overlay | null = null;
let lastVideoId: string | null = null;
// Latest settings, used by the hover tooltip's on-demand word translation.
let activeSettings: Settings | null = null;

async function getSettings(): Promise<Settings> {
  const resp = (await browser.runtime.sendMessage({ type: "getSettings" })) as Settings;
  return resp;
}

function videoIdFromUrl(): string | null {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function langLabel(code: string): string {
  return SOURCE_LANGS.find((l) => l.code === code)?.label ?? code;
}

// Translate a single hovered word into the target language. Cheap and cached in
// api.ts — only words the user actually hovers are ever requested.
async function translateWord(word: string): Promise<string> {
  const s = activeSettings;
  if (!s) return "";
  const source = s.sourceLang;
  const target = s.targetLang;
  if (!word || !target || target === source) return "";
  primeSettings(s);
  const [tr] = await translateBatch([word], target, source);
  return tr ?? "";
}

async function setup(settings: Settings, videoId: string) {
  overlay?.destroy();
  overlay = null;
  if (!settings.enabled) return;

  primeSettings(settings);

  const sourceLang = settings.sourceLang;
  const label = langLabel(sourceLang);

  const track = await findSourceTrack(sourceLang);
  console.log("[romäntik] track=", track);
  if (!track) {
    console.info(`[romäntik] no ${label} caption track on this video`);
    return;
  }

  showBanner(`Enable YouTube CC and pick the ${label} track to activate Romäntik.`);

  // Source captions only — translation happens per word on hover, so there's no
  // second time-aligned line to keep in sync. Keyed by videoId so a cached
  // caption from the previous video can't leak in after SPA navigation.
  const { src: sourceCues } = await requestCues(videoId, sourceLang, "");
  if (sourceCues.length === 0) {
    showBanner(`No ${label} captions captured. Click YouTube CC button, select the ${label} track.`);
    return;
  }
  hideBanner();

  const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
  const playerRoot = document.querySelector<HTMLElement>("#movie_player");
  if (!video || !playerRoot) {
    console.warn("[romäntik] cannot find video or player root");
    return;
  }

  overlay = mountOverlay({
    root: playerRoot,
    video,
    sourceCues,
    settings,
    analyze: (texts) => analyzeBatch(texts, sourceLang),
    onAnalyzeError: () => showBanner(`Cannot reach analyzer at ${settings.backendUrl}. Start the backend (see backend/README.md).`),
    onAnalyzeOk: () => hideBanner(),
  });
}

let banner: HTMLDivElement | null = null;

function showBanner(text: string) {
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "sr-banner";
    banner.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483646;background:#7a1f1f;color:#fff;padding:8px 12px;border-radius:4px;font:13px/1.4 'Segoe UI',Arial,sans-serif;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,0.5);";
    document.body.appendChild(banner);
  }
  banner.textContent = text;
  banner.style.display = "block";
}

function hideBanner() {
  if (banner) banner.style.display = "none";
}

async function tick() {
  const id = videoIdFromUrl();
  console.log("[romäntik] tick, videoId=", id);
  if (!id) return;
  if (id === lastVideoId) return;
  lastVideoId = id;
  const settings = await getSettings();
  activeSettings = settings;
  console.log("[romäntik] settings=", settings);
  setup(settings, id).catch((e) => console.error("[romäntik] setup failed", e));
}

function watchUrlChanges() {
  let lastHref = window.location.href;
  const obs = new MutationObserver(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      tick();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[STORAGE_KEY]) return;
  const newSettings = (changes[STORAGE_KEY].newValue ?? {}) as Settings;
  const prev = (changes[STORAGE_KEY].oldValue ?? {}) as Settings;
  activeSettings = newSettings;
  if (overlay) overlay.applySettings(newSettings);
  const heavyChanged =
    newSettings.sourceLang !== prev.sourceLang ||
    newSettings.backendUrl !== prev.backendUrl ||
    newSettings.enabled !== prev.enabled;
  if (heavyChanged) {
    lastVideoId = null;
    tick();
  }
});

mountTooltip(translateWord);
mountSettingsPanel();
watchUrlChanges();
tick();
