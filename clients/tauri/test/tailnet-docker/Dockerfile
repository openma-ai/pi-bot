FROM node:22-alpine
WORKDIR /app
COPY --chown=10001:10001 server.mjs ./server.mjs
USER 10001:10001
CMD ["node", "server.mjs"]
