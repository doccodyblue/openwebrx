#!/bin/bash
# deploy.sh — Fork-Stand aufs Live-System spiegeln.
#
# Kopiert owrx/ (Python) und htdocs/ (Web-Assets) aus diesem Fork nach
# /usr/local/lib/python3.11/dist-packages/ und startet den Dienst neu.
# Ersetzt das fehleranfällige manuelle Datei-fuer-Datei-Kopieren.
set -euo pipefail

FORK="$(cd "$(dirname "$0")" && pwd)"
LIVE=/usr/local/lib/python3.11/dist-packages

echo "Deploye $(cd "$FORK" && git describe --always --dirty) -> $LIVE"

# Python: strikte Spiegelung (--delete), damit entfernte Module auch live verschwinden.
sudo rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' \
  "$FORK/owrx/" "$LIVE/owrx/"

# Web-Assets: ohne --delete, um nichts Unerwartetes am Live-System zu loeschen.
sudo rsync -a --exclude='__pycache__' --exclude='*.pyc' --exclude='*.bak.*' \
  "$FORK/htdocs/" "$LIVE/htdocs/"

# DSP-Chains (csdr/chain/*.py, z.B. clientaudio.py mit AutoNotch/RNNoise):
# ohne --delete, gleiche Vorsicht wie bei htdocs.
sudo rsync -a --exclude='__pycache__' --exclude='*.pyc' \
  "$FORK/csdr/" "$LIVE/csdr/"

sudo systemctl restart openwebrx
echo "Fertig. Dienst neu gestartet."
