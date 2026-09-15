/*
 * DataLayer Watcher — inject.js
 * Świat: MAIN (ten sam kontekst JS co strona i GTM).
 *
 * Zadanie: podmienić window.dataLayer.push ZANIM gtm.js cokolwiek wypchnie,
 * i przesłać każdy przechwycony event do content-bridge.js (świat ISOLATED)
 * przez window.postMessage.
 *
 * KLUCZOWA NIEZAWODNOŚĆ (klasyczny WooCommerce add_to_cart):
 *   Zdarzenie jest wypychane, a chwilę później następuje nawigacja/przeładowanie.
 *   window.postMessage jest asynchroniczne i może NIE zdążyć się dostarczyć
 *   przed unloadem. Dlatego KAŻDY event zapisujemy dodatkowo SYNCHRONICZNIE
 *   do sessionStorage (setItem jest synchroniczny i przeżywa reload w obrębie
 *   tej samej karty/originu). Po przeładowaniu content-bridge.js odczytuje ten
 *   bufor na document_start i "dosyła" zaległe eventy do background workera.
 *   Deduplikacja odbywa się po unikalnym id eventu.
 */
(function () {
  "use strict";

  // Zapobiegaj podwójnej instalacji (np. bfcache / wielokrotny inject).
  if (window.__DLW_INJECTED__) return;
  window.__DLW_INJECTED__ = true;

  var SOURCE = "datalayer-watcher";
  var SS_KEY = "__dlw_buffer__"; // klucz bufora w sessionStorage
  var SS_MAX = 500; // limit bufora, żeby nie rósł w nieskończoność

  var seq = 0;
  function makeId() {
    seq += 1;
    return (
      Date.now().toString(36) +
      "-" +
      seq.toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // Unikalny identyfikator TEGO załadowania strony. Pozwala background workerowi
  // wykrywać granicę nawigacji deterministycznie (przez zmianę page-id w evencie),
  // zamiast polegać na wyścigu z chrome.tabs.onUpdated — dzięki czemu eventy
  // wypchnięte tuż przed reloadem nie są omyłkowo kasowane.
  var PAGE_LOAD_ID = makeId();

  // Bezpieczna, głęboka serializacja argumentu push (obsługa cykli, funkcji, itp.)
  function safeSerialize(value) {
    var seen = new WeakSet();
    function replacer(key, val) {
      if (typeof val === "function") return "[Function " + (val.name || "anonymous") + "]";
      if (typeof val === "undefined") return "[undefined]";
      if (typeof val === "bigint") return val.toString() + "n";
      if (val instanceof Date) return val.toISOString();
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
        // Rozwiń arguments-like obiekty GTM (np. przekazywane przez gtag)
        if (typeof val.length === "number" && typeof val.callee !== "undefined") {
          return Array.prototype.slice.call(val);
        }
      }
      return val;
    }
    try {
      return JSON.parse(JSON.stringify(value, replacer));
    } catch (e) {
      try {
        return { __dlw_unserializable__: String(value) };
      } catch (e2) {
        return { __dlw_unserializable__: true };
      }
    }
  }

  // Czy payload to zwykły obiekt zdarzenia z niepustym stringiem `event`.
  function hasEventKey(payload) {
    return (
      payload &&
      typeof payload === "object" &&
      Object.prototype.toString.call(payload) === "[object Object]" &&
      typeof payload.event === "string" &&
      payload.event.length > 0
    );
  }

  function guessName(payload) {
    if (payload == null) return "(pusty push)";

    var tag = Object.prototype.toString.call(payload);
    var isArgs = tag === "[object Arguments]";

    // gtag('config'|'js'|'consent'|'set'|'event', ...) trafia jako Arguments/tablica.
    if (isArgs || Array.isArray(payload)) {
      var arr = isArgs ? Array.prototype.slice.call(payload) : payload;
      if (arr[0] === "event" && typeof arr[1] === "string") return arr[1];
      if (typeof arr[0] === "string") {
        return "gtag:" + arr[0] + (typeof arr[1] === "string" ? " " + arr[1] : "");
      }
      return "gtag(…)";
    }

    if (typeof payload === "object") {
      if (typeof payload.event === "string" && payload.event) return payload.event;
      // Obiekty bez klucza `event` — nadaj sensowną etykietę zamiast "(no event name)".
      var keys = Object.keys(payload);
      if (keys.indexOf("gtm.start") !== -1) return "gtm.init";
      if (keys.indexOf("ecommerce") !== -1) return "ecommerce (bez event)";
      if (keys.length) {
        return "{ " + keys.slice(0, 3).join(", ") + (keys.length > 3 ? ", …" : "") + " }";
      }
      return "(pusty obiekt)";
    }

    return "(" + typeof payload + ")";
  }

  // Synchroniczny backup do sessionStorage — ratuje eventy tuż przed unloadem.
  function bufferToSession(record) {
    try {
      var raw = window.sessionStorage.getItem(SS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      arr.push(record);
      if (arr.length > SS_MAX) arr = arr.slice(arr.length - SS_MAX);
      window.sessionStorage.setItem(SS_KEY, JSON.stringify(arr));
    } catch (e) {
      // sessionStorage może być niedostępny (np. tryb prywatny / sandbox) — ignoruj.
    }
  }

  function emit(payload) {
    var record = {
      id: makeId(),
      page: PAGE_LOAD_ID,
      name: guessName(payload),
      named: hasEventKey(payload), // true = ma klucz `event` (nie jest "techniczny")
      time: Date.now(),
      href: location.href,
      data: safeSerialize(payload),
    };

    // 1) Trwały, synchroniczny backup (przeżywa reload).
    bufferToSession(record);

    // 2) Dostarczenie "na żywo" do świata ISOLATED.
    try {
      window.postMessage(
        { source: SOURCE, kind: "dl-event", record: record },
        location.origin || "*"
      );
    } catch (e) {
      // W ostateczności bez targetOrigin.
      try {
        window.postMessage({ source: SOURCE, kind: "dl-event", record: record }, "*");
      } catch (e2) {}
    }
  }

  // Owija konkretną referencję tablicy dataLayer.
  function hookArray(dl) {
    if (!dl || dl.__dlw_hooked__) return dl;
    try {
      Object.defineProperty(dl, "__dlw_hooked__", {
        value: true,
        enumerable: false,
        configurable: true,
      });
    } catch (e) {
      dl.__dlw_hooked__ = true;
    }

    // Przechwyć wszystko, co JUŻ jest w dataLayer (np. wpisy sprzed hooka).
    try {
      for (var i = 0; i < dl.length; i++) {
        emit(dl[i]);
      }
    } catch (e) {}

    var nativePush = dl.push;
    dl.push = function () {
      for (var i = 0; i < arguments.length; i++) {
        try {
          emit(arguments[i]);
        } catch (e) {}
      }
      return nativePush.apply(this, arguments);
    };

    return dl;
  }

  // Przejmij window.dataLayer: jeśli istnieje — hookuj od razu;
  // jeśli nie — złap moment utworzenia przez getter/setter.
  function installDefineProperty() {
    // Jeśli już istnieje realna tablica.
    if (Array.isArray(window.dataLayer)) {
      hookArray(window.dataLayer);
      return;
    }

    var current = window.dataLayer;
    try {
      Object.defineProperty(window, "dataLayer", {
        configurable: true,
        enumerable: true,
        get: function () {
          return current;
        },
        set: function (val) {
          current = val;
          if (Array.isArray(val)) {
            hookArray(val);
          }
        },
      });
      // Jeśli coś było przypisane wcześniej (rzadko), przelej.
      if (current !== undefined) {
        window.dataLayer = current;
      }
    } catch (e) {
      // defineProperty mogło się nie udać — polling zadziała jako fallback.
    }
  }

  // Fallback: polling na wypadek edge case'ów (np. gdy inna wtyczka też
  // redefiniuje property i nasz setter zostanie nadpisany).
  function installPolling() {
    var tries = 0;
    var maxTries = 600; // ~30 s przy 50 ms
    var timer = setInterval(function () {
      tries++;
      try {
        if (Array.isArray(window.dataLayer) && !window.dataLayer.__dlw_hooked__) {
          hookArray(window.dataLayer);
        }
      } catch (e) {}
      if (tries >= maxTries) clearInterval(timer);
    }, 50);
  }

  installDefineProperty();
  installPolling();
})();
