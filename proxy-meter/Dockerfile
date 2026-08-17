# No dependencies: node:net and node:http are the whole implementation, so
# there is nothing to install and nothing to keep patched.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
RUN addgroup -g 10002 meter && adduser -D -u 10002 -G meter meter
USER meter
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${METER_PORT:-8090}/metrics >/dev/null || exit 1
CMD ["node", "server.mjs"]
