#!/bin/bash
set -e
mkdir -p /home/blots/.config /home/blots/profiles
# These process locks are invalid after the previous container has stopped.
python3 - <<'PY'
from pathlib import Path
for screen in range(1, 5):
    for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
        (Path('/home/blots/profiles') / f's{screen}' / name).unlink(missing_ok=True)
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
  x11vnc -display :$n -forever -shared -nopw -rfbport $((5900+n)) -quiet > /tmp/vnc-$n.log 2>&1 &
  DISPLAY=:$n chromium --no-sandbox --test-type --disable-dev-shm-usage --no-first-run \
    --disable-session-crashed-bubble --password-store=basic --disable-background-networking \
    --remote-debugging-port=$((9220+n)) --remote-allow-origins='*' \
    --user-data-dir=/home/blots/profiles/s$n --window-size=1280,800 --start-maximized \
    --app="http://127.0.0.1:8766/?screen=$n" > /tmp/chrome-$n.log 2>&1 &
  socat TCP-LISTEN:$((9230+n)),fork,reuseaddr TCP:127.0.0.1:$((9220+n)) > /tmp/cdp-$n.log 2>&1 &
done
exec python3 /opt/blots/guest.py
