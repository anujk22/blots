#!/bin/bash
set -e
mkdir -p /home/blots/.config/gtk-3.0 /home/blots/profiles
cat > /home/blots/.config/gtk-3.0/settings.ini <<'GTK'
[Settings]
gtk-application-prefer-dark-theme=0
gtk-theme-name=Adwaita
gtk-icon-theme-name=Adwaita
gtk-cursor-theme-name=Blots
gtk-cursor-theme-size=64
GTK
python3 /opt/blots/desktop.py --prepare
export XCURSOR_THEME=Blots XCURSOR_SIZE=64
# Our private displays have no login manager; capture their cursor immediately.
export X11VNC_AVOID_WINDOWS=never
export XDG_RUNTIME_DIR=/tmp/blots-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"
python3 /opt/blots/guest.py &
cleanup() {
  trap - TERM INT
  kill -TERM $(jobs -pr) 2>/dev/null || true
  wait || true
  exit 0
}
trap cleanup TERM INT
wait
