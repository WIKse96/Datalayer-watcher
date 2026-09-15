/*
 * DataLayer Watcher — sidepanel.js
 * UI dla AKTYWNEJ karty: lista eventów (najnowsze na górze), rozwijany JSON
 * z podświetlaniem składni, kopiowanie, filtr po nazwie, Clear, przełącznik
 * zachowywania historii w obrębie domeny.
 */
(function () {
  "use strict";

  // Zbiór eventów ecommerce GA4 — dla kolorowania.
  const ECOM_EVENTS = new Set([
    "add_to_cart",
    "remove_from_cart",
    "view_item",
    "view_item_list",
    "select_item",
    "view_cart",
    "begin_checkout",
    "add_shipping_info",
    "add_payment_info",
    "purchase",
    "refund",
    "add_to_wishlist",
    "select_promotion",
    "view_promotion",
    "generate_lead",
  ]);

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const filterEl = document.getElementById("filter");
  const clearEl = document.getElementById("clear");
  const countEl = document.getElementById("count");
  const domainEl = document.getElementById("domain");
  const keepDomainEl = document.getElementById("keepDomain");
  const tpl = document.getElementById("event-tpl");

  let currentTabId = null;
  let events = []; // pełna lista dla aktywnej karty (rosnąco wg czasu)
  let filterText = "";

  /* ------------------------------ Utils ---------------------------------- */

  function isEcom(name) {
    return ECOM_EVENTS.has(name);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return (
      p(d.getHours()) +
      ":" +
      p(d.getMinutes()) +
      ":" +
      p(d.getSeconds()) +
      "." +
      p(d.getMilliseconds(), 3)
    );
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Proste podświetlanie składni JSON.
  function highlightJson(obj) {
    let json;
    try {
      json = JSON.stringify(obj, null, 2);
    } catch (e) {
      json = String(obj);
    }
    json = escapeHtml(json);
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      function (match) {
        let cls = "tok-num";
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? "tok-key" : "tok-str";
        } else if (/true|false/.test(match)) {
          cls = "tok-bool";
        } else if (/null/.test(match)) {
          cls = "tok-null";
        }
        return '<span class="' + cls + '">' + match + "</span>";
      }
    );
  }

  /* ------------------------------ Render --------------------------------- */

  function passesFilter(ev) {
    if (!filterText) return true;
    return (ev.name || "").toLowerCase().includes(filterText);
  }

  function renderList() {
    const visible = events.filter(passesFilter);
    // Najnowsze na górze.
    const ordered = visible.slice().reverse();

    listEl.querySelectorAll(".event").forEach((n) => n.remove());

    if (events.length === 0) {
      emptyEl.hidden = false;
      emptyEl.innerHTML =
        "Brak przechwyconych eventów dla tej karty.<br />Odśwież stronę z GTM/dataLayer, aby zacząć nasłuch.";
    } else if (ordered.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Brak eventów pasujących do filtra.";
    } else {
      emptyEl.hidden = true;
    }

    const frag = document.createDocumentFragment();
    for (const ev of ordered) {
      frag.appendChild(renderEvent(ev));
    }
    listEl.appendChild(frag);

    updateCount();
  }

  function updateCount() {
    const total = events.length;
    const shown = events.filter(passesFilter).length;
    if (filterText && shown !== total) {
      countEl.textContent = shown + " / " + total + " eventów";
    } else {
      countEl.textContent = total + (total === 1 ? " event" : " eventów");
    }
  }

  function renderEvent(ev) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    if (isEcom(ev.name)) node.classList.add("ecom");

    node.querySelector(".event-name").textContent = ev.name;
    node.querySelector(".event-name").title = ev.name;
    node.querySelector(".event-time").textContent = fmtTime(ev.time);

    const pre = node.querySelector(".event-json");
    const code = pre.querySelector("code");
    let rendered = false;

    const toggle = node.querySelector(".event-toggle");
    toggle.addEventListener("click", () => {
      const open = node.classList.toggle("open");
      pre.hidden = !open;
      if (open && !rendered) {
        code.innerHTML = highlightJson(ev.data);
        rendered = true;
      }
    });

    const copyBtn = node.querySelector(".btn-copy");
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      let text;
      try {
        text = JSON.stringify(ev.data, null, 2);
      } catch (_) {
        text = String(ev.data);
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        // Fallback dla środowisk bez clipboard API.
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (_) {}
        ta.remove();
      }
      copyBtn.textContent = "copied!";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("copied");
      }, 1200);
    });

    return node;
  }

  /* ------------------------ Komunikacja z tłem --------------------------- */

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  async function loadForTab(tabId) {
    currentTabId = tabId;
    const res = await sendMessage({ kind: "get-events", tabId });
    events = (res && res.events) || [];
    if (res && res.settings) {
      keepDomainEl.checked = !!res.settings.keepWithinSameDomain;
    }
    domainEl.textContent = (res && res.domain) || "—";
    renderList();
  }

  async function resolveActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (t) {
          domainEl.textContent = t.url ? hostOf(t.url) : "—";
          resolve(t.id);
        } else {
          resolve(null);
        }
      });
    });
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "—";
    }
  }

  /* ------------------------------ Events --------------------------------- */

  filterEl.addEventListener("input", () => {
    filterText = filterEl.value.trim().toLowerCase();
    renderList();
  });

  clearEl.addEventListener("click", async () => {
    if (currentTabId == null) return;
    await sendMessage({ kind: "clear-tab", tabId: currentTabId });
    events = [];
    renderList();
  });

  keepDomainEl.addEventListener("change", () => {
    sendMessage({
      kind: "set-settings",
      settings: { keepWithinSameDomain: keepDomainEl.checked },
    });
  });

  // Odbiór aktualizacji na żywo z background.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.kind === "dl-event-added" && msg.tabId === currentTabId) {
      // Unikaj duplikatów (na wszelki wypadek).
      if (!events.some((e) => e.id === msg.record.id)) {
        events.push(msg.record);
        if (passesFilter(msg.record)) {
          renderList();
        } else {
          updateCount();
        }
      }
    } else if (msg.kind === "tab-cleared" && msg.tabId === currentTabId) {
      events = [];
      renderList();
    }
  });

  // Przełączanie kart -> przeładuj panel dla nowej aktywnej karty.
  chrome.tabs.onActivated.addListener((info) => {
    loadForTab(info.tabId);
  });
  chrome.windows.onFocusChanged.addListener(async () => {
    const tabId = await resolveActiveTab();
    if (tabId != null) loadForTab(tabId);
  });

  // Start.
  (async function init() {
    const tabId = await resolveActiveTab();
    if (tabId != null) {
      await loadForTab(tabId);
    } else {
      renderList();
    }
  })();
})();
