#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ICONS_DIR="$SCRIPT_DIR/web/public/icons"
RENDERER="$SCRIPT_DIR/scripts/render-svg.js"

echo "Rendering regular icons…"
node "$RENDERER" "$SCRIPT_DIR/web/public/icon.svg" "$ICONS_DIR" 192 512
cp "$ICONS_DIR/icon-192.png" /tmp/_copa_icon_192.png
cp "$ICONS_DIR/icon-512.png" /tmp/_copa_icon_512.png

echo "Rendering maskable icons…"
node "$RENDERER" "$ICONS_DIR/icon-maskable.svg" "$ICONS_DIR" 192 512
mv "$ICONS_DIR/icon-192.png" "$ICONS_DIR/icon-192-maskable.png"
mv "$ICONS_DIR/icon-512.png" "$ICONS_DIR/icon-512-maskable.png"

cp /tmp/_copa_icon_192.png "$ICONS_DIR/icon-192.png"
cp /tmp/_copa_icon_512.png "$ICONS_DIR/icon-512.png"

echo "Done — icons in $ICONS_DIR"
