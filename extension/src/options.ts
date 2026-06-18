import browser from "webextension-polyfill";
import { DEFAULT_SETTINGS, LANGS, SOURCE_LANGS, LangOption, Settings } from "./types";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el as T;
}

function populate(select: HTMLSelectElement, langs: LangOption[]) {
  for (const { code, label } of langs) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${label} (${code})`;
    select.appendChild(opt);
  }
}

async function load(): Promise<Settings> {
  const resp = (await browser.runtime.sendMessage({ type: "getSettings" })) as Settings;
  return { ...DEFAULT_SETTINGS, ...resp };
}

async function save(settings: Partial<Settings>): Promise<Settings> {
  return (await browser.runtime.sendMessage({ type: "setSettings", settings })) as Settings;
}

function setValues(s: Settings) {
  $<HTMLSelectElement>("sr-source").value = s.sourceLang;
  $<HTMLSelectElement>("sr-lang").value = s.targetLang;
  $<HTMLInputElement>("sr-backend").value = s.backendUrl;
  $<HTMLInputElement>("sr-enabled").checked = s.enabled;
  $<HTMLInputElement>("sr-colors").checked = s.showColors;
  $<HTMLInputElement>("sr-tooltips").checked = s.showTooltips;
  $<HTMLInputElement>("sr-pos").value = String(s.overlayPosition);
  $<HTMLOutputElement>("sr-pos-val").value = `${s.overlayPosition}%`;
}

function readValues(): Partial<Settings> {
  return {
    sourceLang: $<HTMLSelectElement>("sr-source").value,
    targetLang: $<HTMLSelectElement>("sr-lang").value,
    backendUrl: $<HTMLInputElement>("sr-backend").value.trim() || DEFAULT_SETTINGS.backendUrl,
    enabled: $<HTMLInputElement>("sr-enabled").checked,
    showColors: $<HTMLInputElement>("sr-colors").checked,
    showTooltips: $<HTMLInputElement>("sr-tooltips").checked,
    overlayPosition: parseInt($<HTMLInputElement>("sr-pos").value, 10),
  };
}

async function init() {
  populate($<HTMLSelectElement>("sr-source"), SOURCE_LANGS);
  populate($<HTMLSelectElement>("sr-lang"), LANGS);
  const settings = await load();
  setValues(settings);
  const status = $<HTMLSpanElement>("sr-status");
  const pos = $<HTMLInputElement>("sr-pos");
  const posVal = $<HTMLOutputElement>("sr-pos-val");
  pos.addEventListener("input", () => {
    posVal.value = `${pos.value}%`;
  });
  $<HTMLFormElement>("sr-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await save(readValues());
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1500);
  });
}

init().catch((e) => console.error("[romäntik] options init failed", e));
