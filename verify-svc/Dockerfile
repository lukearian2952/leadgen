# verify-svc — multi-stage build.
#
# `go mod tidy` runs inside the build rather than a committed go.sum, because
# there is no Go toolchain on the development machine to generate one. Once you
# have Go locally, run `go mod tidy` and commit go.sum, then drop the tidy step
# here — a pinned go.sum is the reproducible option and this is the pragmatic
# one.

FROM golang:1.23-alpine AS build

RUN apk add --no-cache git ca-certificates

WORKDIR /src

COPY go.mod ./
COPY main.go ./
COPY internal ./internal

RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/verify-svc .

# ── runtime ───────────────────────────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 10001 verify

COPY --from=build /out/verify-svc /usr/local/bin/verify-svc

USER verify

EXPOSE 8080

# The container runs with host networking in docker-compose so the prober can
# bind the VPS's public IPs directly; without that, LocalAddr binding fails and
# IP rotation is impossible.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/verify-svc"]
