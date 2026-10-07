#!/bin/bash
set -e
mkdir -p /home/blots/.config/gtk-3.0 /home/blots/profiles
cat > /home/blots/.config/gtk-3.0/settings.ini <<'GTK'
[Settings]
gtk-application-prefer-dark-theme=0
gtk-theme-name=Adwaita
gtk-icon-theme-name=Adwaita
GTK
python3 /opt/blots/desktop.py --prepare
export XDG_RUNTIME_DIR=/tmp/blots-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"
for n in 1 2 3 4; do
  Xvfb :$n -screen 0 1280x960x24 -nolisten tcp > /tmp/xvfb-$n.log 2>&1 &
done
sleep 1
for n in 1 2 3 4; do
  DISPLAY=:$n xfwm4 --compositor=off > /tmp/wm-$n.log 2>&1 &
  x11vnc -display :$n -forever -shared -nopw -nocursorshape -nocursorpos -rfbport $((5900+n)) -quiet > /tmp/vnc-$n.log 2>&1 &
  DISPLAY=:$n python3 /opt/blots/desktop.py $n > /tmp/dock-$n.log 2>&1 &
  DISPLAY=:$n chromium --no-sandbox --test-type --disable-dev-shm-usage --no-first-run \
    --hide-crash-restore-bubble --password-store=basic --disable-background-networking \
    --remote-debugging-port=$((9220+n)) \
    --user-data-dir=/home/blots/profiles/s$n --window-size=1120,792 --window-position=80,80 \
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
