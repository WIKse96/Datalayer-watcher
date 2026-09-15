/*
 * DataLayer Watcher — background.js (service worker, MV3)
 *
 * Odpowiedzialności:
 *  1. Rejestracja content scriptów przez chrome.scripting.registerContentScripts:
 *       - inject.js       -> world MAIN,     runAt document_start
 *       - content-bridge.js -> world ISOLATED, runAt document_start
 *  2. Odbiór eventów od content-bridge, przechowywanie PER tabId
 *     (pamięć + chrome.storage.session jako backup przeżywający restart SW).
 *  3. Deduplikacja po id eventu (ważne dla ścieżki odzysku po reloadzie).
 *  4. Badge z licznikiem na ikonie (per karta).
 *  5. Czyszczenie historii: zamknięcie karty / zmiana domeny (z przełącznikiem
 *     "zachowaj historię między nawigacjami w obrębie tej samej domeny").
 *  6. Konfiguracja side panelu.
 */

const STORAGE_PREFIX = "dlw_tab_";
const SETTINGS_KEY = "dlw_settings";
const MAX_EVENTS_PER_TAB = 1000;

// Ustawienia domyślne. keepWithinSameDomain=true -> historia przeżywa
// przeładowania w obrębie tej samej domeny (kluczowe dla WooCommerce reload).
const DEFAULT_SETTINGS = { keepWithinSameDomain: true };

// Stan w pamięci: tabId -> { events, seen, domain, lastPage }
const tabs = new Map();

// Cache ustawień w pamięci, żeby decyzja o czyszczeniu przy nawigacji była
// SYNCHRONICZNA (bez await w gorącej ścieżce dodawania eventu -> bez wyścigu).
let settingsCache = Object.assign({}, DEFAULT_SETTINGS);

/* --------------------------- Rejestracja skryptów -------------------------- */

async function registerScripts() {
  const desired = [
    {
      id: "dlw-inject-main",
      js: ["inject.js"],
      matches: ["<all_urls>"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
    },
    {
      id: "dlw-bridge-isolated",
      js: ["content-bridge.js"],
      matches: ["<all_urls>"],
      runAt: "document_start",
      world: "ISOLATED",
      allFrames: true,
    },
  ];

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const existingIds = new Set(existing.map((s) => s.id));
    const toRegister = desired.filter((s) => !existingIds.has(s.id));
    // Zaktualizuj ewentualnie istniejące (np. po update wtyczki).
    const toUpdate = desired.filter((s) => existingIds.has(s.id));
    if (toUpdate.length) {
      await chrome.scripting.updateContentScripts(toUpdate);
    }
    if (toRegister.length) {
      await chrome.scripting.registerContentScripts(toRegister);
    }
  } catch (e) {
    // Ostatnia deska ratunku: spróbuj wyrejestrować i zarejestrować od zera.
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: desired.map((s) => s.id),
      });
    } catch (_) {}
    try {
      await chrome.scripting.registerContentScripts(desired);
    } catch (e2) {
      console.error("[DLW] Nie udało się zarejestrować content scriptów:", e2);
    }
  }
}

/* ------------------------------- Ustawienia -------------------------------- */

async function getSettings() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = Object.assign({}, DEFAULT_SETTINGS, res[SETTINGS_KEY] || {});
  return settingsCache;
}

/* ----------------------------- Persystencja -------------------------------- */

function storageKey(tabId) {
  return STORAGE_PREFIX + tabId;
}

async function persistTab(tabId) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  try {
    await chrome.storage.session.set({
      [storageKey(tabId)]: { events: entry.events, domain: entry.domain },
    });
  } catch (e) {
    // storage.session ma limit — w razie czego przytnij i spróbuj ponownie.
    if (entry.events.length > 200) {
      entry.events = entry.events.slice(-200);
      try {
        await chrome.storage.session.set({
          [storageKey(tabId)]: { events: entry.events, domain: entry.domain },
        });
      } catch (_) {}
    }
  }
}

async function restoreFromSession() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const key of Object.keys(all)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      const tabId = parseInt(key.slice(STORAGE_PREFIX.length), 10);
      if (Number.isNaN(tabId)) continue;
      const saved = all[key] || {};
      const events = Array.isArray(saved.events) ? saved.events : [];
      const seen = new Set(events.map((e) => e.id));
      const knownPages = new Set(events.map((e) => e.page).filter(Boolean));
      tabs.set(tabId, { events, seen, domain: saved.domain || null, knownPages });
      updateBadge(tabId);
    }
  } catch (e) {}
}

/* -------------------------------- Badge ------------------------------------ */

function updateBadge(tabId) {
  const entry = tabs.get(tabId);
  const count = entry ? entry.events.length : 0;
  const text = count > 0 ? (count > 999 ? "999+" : String(count)) : "";
  try {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#0b7a3b" });
  } catch (e) {}
}

/* ------------------------------ Domeny/host -------------------------------- */

function hostOf(urlOrOrigin) {
  if (!urlOrOrigin) return null;
  try {
    return new URL(urlOrOrigin).hostname || null;
  } catch (e) {
    return null;
  }
}

// Kilka popularnych wieloczłonowych sufiksów (żeby www/subdomeny i warianty
// typu example.com.pl nie były traktowane jako "inna domena").
const MULTI_TLD = new Set([
  "com.pl", "net.pl", "org.pl", "co.uk", "org.uk", "co.jp", "com.au",
  "com.br", "co.nz", "com.tr", "com.mx", "co.za",
]);

// "Domena rejestrowalna" (eTLD+1) — z pominięciem www. Dzięki temu przejście
// sklep.example.com -> example.com (albo www) NIE jest zmianą domeny.
function registrableDomain(host) {
  if (!host) return null;
  host = host.replace(/^www\./i, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_TLD.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

function sameSite(hostA, hostB) {
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  return a && b && a === b;
}

/* --------------------------- Dodawanie eventu ------------------------------ */

function ensureTab(tabId) {
  let entry = tabs.get(tabId);
  if (!entry) {
    entry = { events: [], seen: new Set(), domain: null, knownPages: new Set() };
    tabs.set(tabId, entry);
  }
  return entry;
}

async function addEvent(tabId, record, origin) {
  if (tabId == null || !record || !record.id) return;
  const entry = ensureTab(tabId);

  // Deduplikacja (live vs. odzysk z sessionStorage). Odzyskane eventy sprzed
  // reloadu, które już mamy w pamięci, zostaną tu odrzucone jako duplikaty.
  if (entry.seen.has(record.id)) return;

  const host = hostOf(origin) || hostOf(record.href);

  // --- Deterministyczne czyszczenie na granicy nawigacji ---
  // Zamiast polegać na wyścigu z chrome.tabs.onUpdated, wykrywamy nowe
  // załadowanie strony po pojawieniu się nieznanego record.page. Decyzję
  // podejmujemy SYNCHRONICZNIE, ZANIM dodamy bieżący event — więc event, który
  // otworzył nową generację (np. add_to_cart tuż po reloadzie), przetrwa
  // czyszczenie zamiast paść jego ofiarą. Śledzimy ZBIÓR znanych page-id, więc
  // odzyskane (starsze) eventy sprzed reloadu nie wywołują ponownego czyszczenia.
  const isNewPageLoad = record.page && !entry.knownPages.has(record.page);
  if (isNewPageLoad && entry.knownPages.size > 0 && entry.events.length > 0) {
    const domainChanged = entry.domain && host && !sameSite(entry.domain, host);
    if (domainChanged || !settingsCache.keepWithinSameDomain) {
      entry.events = [];
      entry.seen = new Set();
      entry.knownPages = new Set();
    }
  }
  if (record.page) entry.knownPages.add(record.page);

  entry.seen.add(record.id);

  if (host) entry.domain = host;
  else if (entry.domain == null) entry.domain = hostOf(record.href);

  entry.events.push(record);
  if (entry.events.length > MAX_EVENTS_PER_TAB) {
    const removed = entry.events.splice(0, entry.events.length - MAX_EVENTS_PER_TAB);
    removed.forEach((r) => entry.seen.delete(r.id));
  }

  updateBadge(tabId);
  await persistTab(tabId);

  // Powiadom side panel (jeśli otwarty) o nowym evencie.
  try {
    chrome.runtime.sendMessage(
      { kind: "dl-event-added", tabId, record },
      function () {
        void chrome.runtime.lastError;
      }
    );
  } catch (e) {}
}

async function clearTab(tabId) {
  const entry = tabs.get(tabId);
  if (entry) {
    entry.events = [];
    entry.seen = new Set();
  }
  updateBadge(tabId);
  try {
    await chrome.storage.session.remove(storageKey(tabId));
  } catch (e) {}
  try {
    chrome.runtime.sendMessage({ kind: "tab-cleared", tabId }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

/* ------------------------------ Zdarzenia ---------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Wiadomości od content scriptów (mają sender.tab).
  if (msg.kind === "dl-event" && sender.tab && sender.tab.id != null) {
    addEvent(sender.tab.id, msg.record, msg.origin);
    return; // brak odpowiedzi
  }

  if (msg.kind === "content-ready" && sender.tab && sender.tab.id != null) {
    // nic krytycznego; badge zostanie zaktualizowany przy eventach
    return;
  }

  // Wiadomości od side panelu.
  if (msg.kind === "get-events") {
    const tabId = msg.tabId;
    const entry = tabs.get(tabId);
    getSettings().then((settings) => {
      sendResponse({
        events: entry ? entry.events : [],
        domain: entry ? entry.domain : null,
        settings,
      });
    });
    return true; // odpowiedź asynchroniczna
  }

  if (msg.kind === "clear-tab") {
    clearTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.kind === "get-settings") {
    getSettings().then((settings) => sendResponse({ settings }));
    return true;
  }

  if (msg.kind === "set-settings") {
    getSettings().then((current) => {
      const next = Object.assign({}, current, msg.settings || {});
      settingsCache = next;
      chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => {
        sendResponse({ settings: next });
      });
    });
    return true;
  }
});

// Czyszczenie przy zamknięciu karty.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
});

// Uwaga: czyszczenie przy zmianie domeny / nawigacji jest teraz realizowane
// DETERMINISTYCZNIE w addEvent() (na podstawie record.page), a nie tutaj —
// dawny listener chrome.tabs.onUpdated ścigał się z odzyskiem eventów sprzed
// reloadu i kasował m.in. add_to_cart. Zamknięcie karty obsługuje onRemoved.

/* --------------------------- Inicjalizacja SW ------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  registerScripts();
});

chrome.runtime.onStartup.addListener(() => {
  registerScripts();
  restoreFromSession();
});

// Side panel: otwieraj po kliknięciu w ikonę rozszerzenia.
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
} catch (e) {}

// Uruchomienie przy każdym starcie service workera.
registerScripts();
restoreFromSession();
getSettings(); // wczytaj ustawienia do settingsCache (synchroniczna decyzja w addEvent)
