#!/bin/bash
# PakSwap Studio installer for Linux (Mint, Ubuntu, Fedora and others).
#
#   bash install-linux.sh                     looks in ~/Downloads and in this folder
#   bash install-linux.sh <file>              a .tar.gz, an .AppImage, or an app folder
#   bash install-linux.sh --uninstall         removes it again
#
# Installs into your home folder and adds PakSwap Studio to the applications menu.
# No sudo, nothing touched outside your home folder.
set -e
NAME=pakswap-studio
DEST="$HOME/.local/share/$NAME"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
BIN="$HOME/.local/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$DEST" "$APPS/$NAME.desktop" "$ICONS/$NAME.png" "$BIN/$NAME"
  update-desktop-database "$APPS" >/dev/null 2>&1 || true
  echo "PakSwap Studio removed."
  exit 0
fi

# ---- find what to install -------------------------------------------------
SRC="${1:-}"
if [ -z "$SRC" ]; then
  for c in "$HERE"/PakSwap-Studio-*-linux-x64.tar.gz "$HOME"/Downloads/PakSwap-Studio-*-linux-x64.tar.gz \
           "$HERE"/PakSwap-Studio-*.AppImage "$HOME"/Downloads/PakSwap-Studio-*.AppImage \
           "$HERE"/PakSwap-Studio-Linux "$HOME"/Downloads/PakSwap-Studio-Linux; do
    [ -e "$c" ] && { SRC="$c"; break; }
  done
fi
if [ -z "$SRC" ] || [ ! -e "$SRC" ]; then
  echo "Could not find the PakSwap Studio download." >&2
  echo "Run it like this:  bash install-linux.sh ~/Downloads/PakSwap-Studio-1.2.0-linux-x64.tar.gz" >&2
  exit 1
fi
echo "Installing from: $SRC"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$SRC" in
  *.tar.gz|*.tgz)
    tar -xzf "$SRC" -C "$TMP"
    APPDIR="$(find "$TMP" -maxdepth 2 -name pakswap-studio -type f -printf '%h\n' | head -1)"
    ;;
  *.AppImage)
    chmod +x "$SRC" 2>/dev/null || true
    ( cd "$TMP" && "$SRC" --appimage-extract >/dev/null )
    APPDIR="$TMP/squashfs-root"
    ;;
  *)
    APPDIR="$SRC"
    ;;
esac

if [ -z "${APPDIR:-}" ] || [ ! -f "$APPDIR/pakswap-studio" ]; then
  echo "That file does not look like the PakSwap Studio Linux download." >&2
  exit 1
fi

# ---- copy it into place ---------------------------------------------------
mkdir -p "$DEST" "$APPS" "$ICONS" "$BIN"
rm -rf "$DEST/app"
mkdir -p "$DEST/app"
cp -r "$APPDIR"/. "$DEST/app/"
rm -f "$DEST/app/AppRun" "$DEST/app/$NAME.desktop" "$DEST/app/.DirIcon"
chmod +x "$DEST/app/pakswap-studio" "$DEST/app/chrome_crashpad_handler" "$DEST/app/chrome-sandbox" 2>/dev/null || true

# ---- icon -----------------------------------------------------------------
if [ -f "$DEST/app/$NAME.png" ]; then
  cp "$DEST/app/$NAME.png" "$ICONS/$NAME.png"
else
  python3 - "$DEST/app/resources/app.asar" "$ICONS/$NAME.png" <<'PY' || true
import json, struct, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, 'rb') as f:
    hs = struct.unpack('<I', f.read(8)[4:8])[0]
    hdr = f.read(hs)
    j = json.loads(hdr[8:8 + struct.unpack('<I', hdr[4:8])[0]])
    node = j['files']['build']['files']['icon.png']
    f.seek(8 + hs + int(node['offset']))
    open(dst, 'wb').write(f.read(node['size']))
PY
fi

# ---- launcher (falls back to --no-sandbox only if the sandbox is blocked) --
cat > "$BIN/$NAME" <<EOF
#!/bin/bash
APP="$DEST/app/pakswap-studio"
ERR="\$(mktemp)"
"\$APP" "\$@" 2>"\$ERR"; code=\$?
if [ \$code -ne 0 ] && grep -qiE "sandbox|namespace" "\$ERR"; then rm -f "\$ERR"; exec "\$APP" --no-sandbox "\$@"; fi
cat "\$ERR" >&2; rm -f "\$ERR"; exit \$code
EOF
chmod +x "$BIN/$NAME"

# ---- menu entry -----------------------------------------------------------
cat > "$APPS/$NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PakSwap Studio
Comment=Pakistani car engine swaps, sound, specs and open-world driving
Exec=$BIN/$NAME %U
Icon=$NAME
Terminal=false
Categories=Game;Simulation;
StartupWMClass=PakSwap Studio
EOF
chmod +x "$APPS/$NAME.desktop"
update-desktop-database "$APPS" >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo
echo "Done. Open the menu and type PakSwap, or run: $BIN/$NAME"
