# DataLayer Watcher

Rozszerzenie do Chrome (Manifest V3), które w **czasie rzeczywistym**
przechwytuje i zapisuje **wszystkie** eventy wypychane do `window.dataLayer`
(Google Tag Manager / GA4) na dowolnej stronie — łącznie z eventami
wypychanymi **tuż przed przeładowaniem strony** (klasyczny, nie-AJAX-owy
`add_to_cart` w WooCommerce), które normalnie giną razem z resetem konsoli.

## Dlaczego to działa tam, gdzie konsola zawodzi

Klasyczny WooCommerce push do `dataLayer`, po którym następuje natychmiastowa
nawigacja/przeładowanie, gubi się w zwykłej konsoli (reset). DataLayer Watcher
stosuje **podwójną ścieżkę dostarczania**:

1. **Na żywo** — hook w świecie `MAIN` przechwytuje `dataLayer.push` i przez
   `window.postMessage` przekazuje event do mostka (`ISOLATED`), który wysyła
   go do service workera.
2. **Odzysk po reload** — ponieważ `postMessage` jest asynchroniczne i może nie
   zdążyć przed unloadem, **każdy** event jest dodatkowo zapisywany
   **synchronicznie** do `sessionStorage` (co przeżywa reload w obrębie tej
   samej karty). Po przeładowaniu mostek odczytuje bufor na `document_start`
   i „dosyła” zaległe eventy. Deduplikacja po unikalnym `id` gwarantuje brak
   duplikatów.

Dzięki temu event wypchnięty ułamek sekundy przed przeładowaniem **nie ginie**.

## Funkcje

- Hook wstrzykiwany w `document_start`, świat `MAIN` (przez
  `chrome.scripting.registerContentScripts`) — podmienia `dataLayer.push`
  zanim GTM/GA cokolwiek wypchnie.
- Przechwytuje `dataLayer` nawet jeśli jeszcze nie istnieje (`Object.defineProperty`
  na `window`) + fallback polling.
- Historia **per karta**, przechowywana w pamięci **i** `chrome.storage.session`
  (przeżywa restart service workera i przeładowanie strony).
- UI jako **Chrome side panel**:
  - lista eventów, najnowsze na górze (nazwa + znacznik czasu z ms),
  - rozwijany/zwijany pełny JSON z podświetlaniem składni,
  - przycisk **copy JSON** przy każdym evencie,
  - **filtr** po nazwie eventu (np. `add_to_cart`),
  - przycisk **Clear** czyszczący historię danej karty,
  - **badge** z licznikiem eventów na ikonie rozszerzenia.
- Kolorystyczne rozróżnienie: **zielony** akcent dla eventów ecommerce GA4
  (`add_to_cart`, `view_item`, `purchase`, `begin_checkout`, …), **szary** dla
  standardowych eventów GTM (`gtm.js`, `gtm.dom`, `gtm.load`, `gtm.click`).
- Automatyczne czyszczenie historii przy zamknięciu karty lub przejściu na inną
  domenę, z przełącznikiem **„Zachowaj historię między nawigacjami w obrębie tej
  samej domeny”** (domyślnie włączony — kluczowe dla scenariusza WooCommerce reload).

## Instalacja (Load unpacked) — krok po kroku

Dla kogoś, kto nigdy nie ładował unpacked extension:

1. Pobierz/rozpakuj ten folder (`datalayer-watcher`) w dowolne miejsce na dysku.
   Musi zawierać `manifest.json` bezpośrednio w środku.
2. Otwórz Chrome i wpisz w pasku adresu: `chrome://extensions`
3. W prawym górnym rogu włącz **„Tryb dewelopera” / „Developer mode”**.
4. Kliknij **„Wczytaj rozpakowane” / „Load unpacked”**.
5. Wskaż folder `datalayer-watcher` (ten z plikiem `manifest.json`) i zatwierdź.
6. Rozszerzenie „DataLayer Watcher” pojawi się na liście. Przypnij je do paska
   (ikona puzzla → pinezka), żeby mieć szybki dostęp.

## Użycie

1. Wejdź na stronę korzystającą z GTM / `dataLayer` (np. sklep WooCommerce).
2. Kliknij ikonę **DataLayer Watcher** — otworzy się **side panel** po prawej.
3. Eventy pojawiają się na żywo. Kliknij nazwę eventu, aby rozwinąć JSON.
4. Test scenariusza WooCommerce: kliknij „Dodaj do koszyka” na klasycznym
   (nie-AJAX) przycisku. Strona się przeładuje, a event `add_to_cart` i tak
   **zostanie na liście**.
5. Filtruj po nazwie (np. `add_to_cart`), kopiuj JSON, czyść historię przyciskiem
   **Clear**.

> Uwaga: po pierwszej instalacji odśwież już otwarte karty — content scripty
> rejestrują się dla nowych/odświeżonych stron.

## Struktura projektu

```
datalayer-watcher/
├── manifest.json         # Manifest V3, uprawnienia, side_panel
├── background.js         # service worker: rejestracja skryptów, magazyn per-tab, badge
├── content-bridge.js     # świat ISOLATED: most postMessage <-> chrome.runtime
├── inject.js             # świat MAIN: hook na dataLayer.push (+ backup do sessionStorage)
├── sidepanel.html        # UI panelu bocznego
├── sidepanel.css         # style + kolory ecommerce/GTM + podświetlanie JSON
├── sidepanel.js          # logika UI: lista, filtr, copy, clear, ustawienia
├── icons/                # ikony 16/48/128 px
└── README.md
```

## Uprawnienia i prywatność

- `permissions`: `storage`, `scripting`, `activeTab`, `tabs`, `sidePanel`
- `host_permissions`: `<all_urls>` — hook musi działać na dowolnej stronie.

Dane (przechwycone eventy) są przechowywane **wyłącznie lokalnie** w pamięci
przeglądarki i `chrome.storage.session` (czyszczone po zamknięciu przeglądarki).
Nic nie jest wysyłane na zewnątrz.

## Rozwiązywanie problemów

- **Brak eventów?** Odśwież stronę po instalacji. Sprawdź w `chrome://extensions`,
  czy nie ma błędów w service workerze (przycisk „service worker” → konsola).
- **Nie widać badge / panelu?** Przypnij rozszerzenie i kliknij jego ikonę.
- **Strona nadpisuje `dataLayer`?** Zadziała fallback polling — event zostanie
  przechwycony do ~30 s od załadowania.
