FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc xdotool scrot dbus-x11 xfwm4 xfce4-panel xfce4-terminal \
    thunar mousepad chromium python3 socat fonts-dejavu adwaita-icon-theme \
    ca-certificates curl procps tzdata feh python3-gi gir1.2-gtk-3.0 \
    python3-cairo python3-gi-cairo && rm -rf /var/lib/apt/lists/*
# Optional desktop apps (several GB). Build with --build-arg FULL_APPS=1 to include them.
ARG FULL_APPS=0
RUN if [ "$FULL_APPS" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends \
    blender libreoffice-draw freecad gimp godot3 inkscape kdenlive kicad \
    openscad paraview qgis aisleriot && rm -rf /var/lib/apt/lists/*; fi
RUN useradd -m -u 1000 -s /bin/bash blots && mkdir -p /opt/blots /workspace && chown -R blots:blots /workspace
COPY guest.py home.html start.sh desktop.py cursor.py pointer.py screen.py apps.json /opt/blots/
COPY avatars /opt/blots/avatars/
RUN chmod +x /opt/blots/start.sh
USER blots
WORKDIR /workspace
EXPOSE 8766 5901 9231
ENTRYPOINT ["/opt/blots/start.sh"]
