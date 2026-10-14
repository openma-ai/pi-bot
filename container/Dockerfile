FROM node:24.18.0-trixie
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc websockify novnc xdotool wmctrl x11-xserver-utils dbus-x11 imagemagick libatk-adaptor at-spi2-core fonts-noto-cjk tini openssh-client && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts && npm install --no-save --ignore-scripts --legacy-peer-deps --registry=https://registry.npmjs.org @agent-sh/computer-use-linux@0.7.16 && node node_modules/@agent-sh/computer-use-linux/npm/install.js
COPY . .
RUN node scripts/apply-pi-background-bridge.mjs && npm run gui:build && mkdir -p /data /app/work/gui/desktop && chown -R node:node /data /app/work
USER node
EXPOSE 8080 4317
ENTRYPOINT ["/usr/bin/tini","--","/app/container/start-desktop.sh"]
