# Build from a staging context containing tracked project sources only.
FROM pibo-tailnet-desktop:local
COPY --chown=node:node . /app
# Docker initializes the dedicated named volume with this unprivileged owner.
RUN mkdir -p /data/runtime && chmod 700 /data/runtime
ENTRYPOINT ["/usr/bin/tini","--","/app/clients/tauri/test/tailnet-docker/direct/start.sh"]
