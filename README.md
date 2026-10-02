# stash-plugins

Plugins für [Stash](https://github.com/stashapp/stash).

## Installation

1. In Stash: **Settings → Plugins → Available Plugins → Add Source**
2. Eintragen:
   - **Name:** `JimnyCricket`
   - **Source URL:** `https://xxjimnycricketxx.github.io/stash-plugins/index.yml`
3. Gewünschtes Plugin auswählen und installieren.

## Plugins

| Plugin | Beschreibung |
| --- | --- |
| [Grouped Tags View](plugins/groupedTagsView) | Zeigt Tags gruppiert nach ihren Parent-Tags als Bildergalerie. |

## Entwicklung

Jedes Plugin liegt unter `plugins/<pluginId>/` mit einer `<pluginId>.yml`.
Bei jedem Push auf `main` baut [build_site.sh](build_site.sh) per GitHub Action
die `index.yml` und die Zip-Pakete und veröffentlicht sie auf GitHub Pages.

Lokal testen: den Plugin-Ordner in das `plugins`-Verzeichnis der Stash-Konfiguration
kopieren bzw. mounten und in Stash **Settings → Plugins → Reload Plugins** ausführen.
