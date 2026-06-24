# Pokelike Shiny Hunter

Ein automatisiertes Browser-Addon für [pokelike.xyz](https://pokelike.xyz/), das den Run-Prozess (Map-Node betreten → Pokémon prüfen → Reset) vollautomatisch und in maximaler Geschwindigkeit durchführt, bis ein gewünschtes Shiny-Pokémon gefunden wird.

Das Addon besitzt **kein lästiges Popup-Fenster** in der Browserleiste mehr. Stattdessen wird direkt auf der Webseite ein elegantes, frei verschiebbares **In-Page-Steuerungspanel** eingebettet.

---

## Features

- 🎛️ **In-Page Control Panel (Shadow DOM)**: Verwalte deine Ziel-Pokémon und starte/stoppe die Suche direkt auf der Webseite.
- 🖐️ **Draggable UI**: Ziehe das Widget oder den minimierten Button frei mit der Maus dorthin, wo es dich nicht stört. Die Position wird persistent im Browser gespeichert.
- ⚡ **Maximale Geschwindigkeit**: Extrem optimierte Wartezeiten und Reaktionszeiten (ca. 2 Sekunden pro Suchdurchlauf).
- 🗺️ **Linkeste-Node-Garantie**: Erkennt alle klickbaren Map-Nodes und wählt automatisch immer die am weitesten links liegende Node aus.
- 🌟 **Shiny-Erkennung**: Stoppt die Suche sofort und sendet eine Desktop-Benachrichtigung sowie ein Badge-Signal, sobald ein eingetragenes Shiny-Pokémon im Catch-Screen erscheint.

---

## Installation

Da es sich um eine Entwickler-Erweiterung handelt, wird das Addon direkt aus dem Quellcode-Ordner geladen. Dies funktioniert in allen Chromium-basierten Browsern:

### 1. Google Chrome / Brave Browser / Microsoft Edge
1. Öffne die Erweiterungs-Verwaltung in deinem Browser:
   - **Chrome**: `chrome://extensions/`
   - **Brave**: `brave://extensions/`
   - **Edge**: `edge://extensions/`
2. Aktiviere den **Entwicklermodus** (meistens ein Schalter oben rechts).
3. Klicke auf die Schaltfläche **Entpackte Erweiterung laden** (oder **Entpackt laden**).
4. Wähle den gesamten Projektordner (`chromium-pokelike-addon`) aus.
5. Das Addon ist nun installiert!

### 2. Opera / Opera GX
1. Öffne die Erweiterungs-Verwaltung in Opera:
   - Gib in die Adresszeile `opera://extensions` ein.
2. Aktiviere den **Entwicklermodus** (Schalter oben rechts).
3. Klicke oben links auf **Entpackte Erweiterung laden...**.
4. Wähle das Verzeichnis des Addons aus.
5. Die Erweiterung wird in der Liste angezeigt und ist sofort aktiv.

---

## Benutzung

1. Starte einen Run auf [pokelike.xyz](https://pokelike.xyz/) bis zur Map.
2. Das **Shiny Hunter** Panel erscheint sofort oben rechts auf der Webseite.
3. Trage deine Wunsch-Pokémon im Eingabefeld ein (z.B. `Charmander`, `Eevee`) und klicke auf das **+** Symbol.
4. Klicke auf **▶ Suche starten**. Der Bot übernimmt die Steuerung.
5. Wenn das Widget dich im Spiel stört, klicke oben rechts im Widget auf das **✕** Symbol. Es minimiert sich in ein unauffälliges, schwebendes **★** Stern-Symbol.
6. Ein Klick auf das Extension-Icon in deiner Browser-Leiste klappt das Widget ebenfalls ein oder aus.
7. Sobald ein eingetragenes Shiny-Pokémon gefunden wird, stoppt die Suche und das Addon benachrichtigt dich.