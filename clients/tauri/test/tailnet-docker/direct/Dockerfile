# Build from a staging context containing tracked project sources only.
FROM pibo-tailnet-desktop:local
COPY --chown=node:node . /app
ENTRYPOINT ["/usr/bin/tini","--","/app/clients/tauri/test/tailnet-docker/direct/start.sh"]
