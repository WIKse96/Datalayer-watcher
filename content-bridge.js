/*
 * DataLayer Watcher — content-bridge.js
 * Świat: ISOLATED (ma dostęp do chrome.runtime, ale NIE do window.dataLayer
 * strony). Pełni rolę mostu między inject.js (MAIN) a background.js.
 *
 * Dwie ścieżki dostarczania eventów:
 *   A) NA ŻYWO: nasłuch window.postMessage od inject.js -> chrome.runtime.sendMessage.
 *   B) ODZYSK PO RELOAD: na document_start odczytujemy synchroniczny bufor
 *      z sessionStorage (który inject.js zapisał tuż przed unloadem) i dosyłamy
 *      zaległe eventy. Content script i strona współdzielą sessionStorage tego
 *      samego originu, więc mamy do niego dostęp.
 *
 * Deduplikacja: każdy rekord ma unikalne id; background odrzuca duplikaty.
 */
(function () {
  "use strict";

  var SOURCE = "datalayer-watcher";
  var SS_KEY = "__dlw_buffer__";

  function send(record, origin) {
    try {
      chrome.runtime.sendMessage(
        { kind: "dl-event", record: record, origin: origin },
        function () {
          // Odczyt lastError, żeby uniknąć "Unchecked runtime.lastError".
          void chrome.runtime.lastError;
        }
      );
    } catch (e) {
      // Kontekst rozszerzenia mógł zostać unieważniony (np. reload wtyczki).
    }
  }

  // A) NA ŻYWO
  window.addEventListener(
    "message",
    function (event) {
      if (event.source !== window) return;
      var msg = event.data;
      if (!msg || msg.source !== SOURCE || msg.kind !== "dl-event") return;
      if (!msg.record) return;
      send(msg.record, location.origin);
    },
    false
  );

  // B) ODZYSK PO RELOAD — flush zaległego bufora z sessionStorage.
  function flushBacklog() {
    try {
      var raw = window.sessionStorage.getItem(SS_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return;
      for (var i = 0; i < arr.length; i++) {
        send(arr[i], location.origin);
      }
      // Bufor został przekazany — czyścimy go, deduplikacja i tak zabezpiecza.
      window.sessionStorage.removeItem(SS_KEY);
    } catch (e) {}
  }

  // Uruchamiamy jak najwcześniej (skrypt działa w document_start).
  flushBacklog();

  // Poinformuj background, że karta ma aktywny content (do zarządzania badge itp.).
  try {
    chrome.runtime.sendMessage({ kind: "content-ready", origin: location.origin }, function () {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
})();
