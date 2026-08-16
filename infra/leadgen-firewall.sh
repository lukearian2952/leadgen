#!/bin/bash
# Restrict verify-svc (:8080) to this host and its own containers.
#
# verify-svc runs with `network_mode: host` because the prober has to bind the
# VPS's public IP to rotate outbound addresses. The cost of host networking is
# that it binds 0.0.0.0 — Docker's usual `127.0.0.1:port->` publishing does not
# apply — so the service was reachable from the internet with no authentication.
# `POST /verify` lets an anonymous caller drive SMTP probes from our IP and burn
# its reputation, which is the one asset the whole verification design rests on.
#
# Every other LeadGen port (8085, 8888, 11235, 9101/9106/9107/9108) is published
# by Docker as 127.0.0.1:port and is already unreachable from outside. Only 8080
# needs a rule.
#
# Scope: this touches destination port 8080 and nothing else. Ports belonging to
# the unrelated production workloads on this box — 22, 80, 443, 3000, 5432,
# 5678, 5679, 8069, 8070, 9120, 9209 — are never matched.
#
# Idempotent; safe to re-run. Installed as leadgen-firewall.service.

set -euo pipefail

CHAIN=LEADGEN-FW
PORT=8080

# Accept from container bridges only when the source is also RFC1918. The
# interface match alone would be enough, but requiring both means a spoofed
# private source arriving on the public interface matches neither.
DOCKER_NETS=172.16.0.0/12

install_v4() {
  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

  iptables -A "$CHAIN" -i lo -j RETURN
  iptables -A "$CHAIN" -i docker0 -s "$DOCKER_NETS" -j RETURN
  # Wildcard: compose derives bridge names from the network id, so a
  # `docker compose down && up` renames the interface. Matching br-+ keeps the
  # rule correct across that instead of failing closed and stranding the workers.
  iptables -A "$CHAIN" -i 'br-+' -s "$DOCKER_NETS" -j RETURN
  # DROP, not REJECT: a scanner gets silence rather than a confirmation that
  # something is listening.
  iptables -A "$CHAIN" -j DROP

  iptables -C INPUT -p tcp --dport "$PORT" -j "$CHAIN" 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$PORT" -j "$CHAIN"
}

# The listener is dual-stack (`*:8080`), so without this it stays reachable over
# IPv6 and the v4 rule is a false sense of security. No Docker network on this
# host has an IPv6 subnet, so loopback is the only legitimate v6 source.
install_v6() {
  ip6tables -N "$CHAIN" 2>/dev/null || ip6tables -F "$CHAIN"

  ip6tables -A "$CHAIN" -i lo -j RETURN
  ip6tables -A "$CHAIN" -j DROP

  ip6tables -C INPUT -p tcp --dport "$PORT" -j "$CHAIN" 2>/dev/null ||
    ip6tables -I INPUT 1 -p tcp --dport "$PORT" -j "$CHAIN"
}

install_v4
install_v6

echo "leadgen-firewall: :$PORT restricted to loopback + docker bridges (v4 and v6)"
