#!/bin/bash
set -e
mkdir -p /home/blots/.config/gtk-3.0 /home/blots/profiles
cat > /home/blots/.config/gtk-3.0/settings.ini <<'GTK'
[Settings]
gtk-application-prefer-dark-theme=1
gtk-theme-name=Adwaita-dark
gtk-icon-theme-name=Adwaita
GTK
# These process locks are invalid after the previous container has stopped.
python3 - <<'PY'
from pathlib import Path
import json
for screen in range(1, 5):
    for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
        (Path('/home/blots/profiles') / f's{screen}' / name).unlink(missing_ok=True)
    Path(f'/tmp/.X{screen}-lock').unlink(missing_ok=True)
    Path(f'/tmp/.X11-unix/X{screen}').unlink(missing_ok=True)
    profile = Path('/home/blots/profiles') / f's{screen}' / 'Default'
    profile.mkdir(parents=True, exist_ok=True)
    preferences = profile / 'Preferences'
    settings = json.loads(preferences.read_text()) if preferences.exists() else {}
    settings.setdefault('browser', {})['custom_chrome_frame'] = True
    preferences.write_text(json.dumps(settings))
PY
export XDG_RUNTIME_DIR=/tmp/blots-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"
for n in 1 2 3 4; do
  Xvfb :$n -screen 0 1280x800x24 -nolisten tcp > /tmp/xvfb-$n.log 2>&1 &
done
sleep 1
for n in 1 2 3 4; do
  DISPLAY=:$n xfwm4 --compositor=off > /tmp/wm-$n.log 2>&1 &
  x11vnc -display :$n -forever -shared -nopw -nocursorshape -nocursorpos -rfbport $((5900+n)) -quiet > /tmp/vnc-$n.log 2>&1 &
  DISPLAY=:$n chromium --no-sandbox --test-type --force-dark-mode --disable-dev-shm-usage --no-first-run \
    --hide-crash-restore-bubble --password-store=basic --disable-background-networking \
    --remote-debugging-port=$((9220+n)) \
    --user-data-dir=/home/blots/profiles/s$n --window-size=1280,800 --start-maximized \
    "http://127.0.0.1:8766/?screen=$n" > /tmp/chrome-$n.log 2>&1 &
  socat TCP-LISTEN:$((9230+n)),fork,reuseaddr TCP:127.0.0.1:$((9220+n)) > /tmp/cdp-$n.log 2>&1 &
done
python3 /opt/blots/guest.py &
cleanup() {
  trap - TERM INT
  kill -TERM $(jobs -pr) 2>/dev/null || true
  wait || true
  exit 0
}
trap cleanup TERM INT
wait
