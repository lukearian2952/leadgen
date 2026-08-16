// verify-svc — self-hosted email verification on our own IPs.
//
// Replaces Reacher, which is AGPL-or-paid-commercial and therefore a poor fit
// for a commercial SaaS. The underlying checks come from
// AfterShip/email-verifier (MIT); the throttling, IP rotation and cooldown that
// keep those checks from getting our IPs listed are ours, in internal/prober
// and internal/ipstate.
//
// Endpoints:
//   POST /verify   {"emails": ["a@b.com", ...]}  -> VerifierProvider shape
//   GET  /healthz                                -> liveness + usable IP count
//   GET  /metrics                                -> Prometheus text format
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bezbuilder/leadgen/verify-svc/internal/ipstate"
	"github.com/bezbuilder/leadgen/verify-svc/internal/prober"
)

const maxBatch = 500

type server struct {
	prober *prober.Prober
	ips    *ipstate.Store
	cfg    prober.Config
	log    *slog.Logger

	// Counters for /metrics.
	checksTotal  atomic.Int64
	blocksTotal  atomic.Int64
	batchesTotal atomic.Int64
	safeTotal    atomic.Int64
	invalidTotal atomic.Int64
	riskyTotal   atomic.Int64
	unknownTotal atomic.Int64
}

// requireEnv reads every required variable and reports ALL the missing ones at
// once, matching the workers' behaviour.
//
// One-at-a-time reporting turns a first deploy into four rounds of "start,
// read error, set one variable, restart". Never fall back silently either —
// an unset value here means SMTP probes from the wrong IP or the wrong HELO,
// which is how an IP gets listed.
func requireEnv(names ...string) map[string]string {
	values := make(map[string]string, len(names))
	var missing []string

	for _, name := range names {
		value := strings.TrimSpace(os.Getenv(name))
		if value == "" {
			missing = append(missing, name)
			continue
		}
		values[name] = value
	}

	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr,
			"\n[config] cannot start verify-svc: %d required environment variable(s) missing.\n",
			len(missing))
		for _, name := range missing {
			fmt.Fprintf(os.Stderr, "  - %s\n", name)
		}
		fmt.Fprintf(os.Stderr, "See .env.example for where each value comes from.\n\n")
		os.Exit(78) // EX_CONFIG
	}
	return values
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	env := requireEnv("DATABASE_URL", "VERIFY_IPS", "VERIFY_HELO_DOMAIN", "VERIFY_FROM_EMAIL")

	databaseURL := env["DATABASE_URL"]
	cfg := prober.Config{
		IPs:        splitList(env["VERIFY_IPS"]),
		HeloDomain: env["VERIFY_HELO_DOMAIN"],
		FromEmail:  env["VERIFY_FROM_EMAIL"],
	}
	port := envOr("PORT", "8080")

	if len(cfg.IPs) == 0 {
		fmt.Fprintln(os.Stderr, "[config] VERIFY_IPS contained no usable addresses")
		os.Exit(78)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Error("cannot connect to postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Error("postgres ping failed", "err", err)
		os.Exit(1)
	}

	store := ipstate.New(pool)
	if err := store.Ensure(ctx, cfg.IPs); err != nil {
		log.Error("cannot register verifier IPs", "err", err)
		os.Exit(1)
	}

	srv := &server{
		prober: prober.New(cfg, store),
		ips:    store,
		cfg:    cfg,
		log:    log,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /verify", srv.handleVerify)
	mux.HandleFunc("GET /healthz", srv.handleHealth)
	mux.HandleFunc("GET /metrics", srv.handleMetrics)
	mux.HandleFunc("GET /debug/dial", srv.handleDebugDial)

	log.Info("verify-svc listening",
		"port", port, "ips", cfg.IPs, "helo", cfg.HeloDomain, "from", cfg.FromEmail)

	httpSrv := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
		// A batch of 500 addresses at 3–5 s per RCPT is genuinely slow; the
		// write timeout has to accommodate it or the caller sees a truncated
		// response and treats real verdicts as unknown.
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Minute,
	}
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("http server failed", "err", err)
		os.Exit(1)
	}
}

type verifyRequest struct {
	Emails []string `json:"emails"`
}

type verifyResponse struct {
	Results    []prober.Result `json:"results"`
	Error      string          `json:"error,omitempty"`
	AllCooling bool            `json:"all_cooling,omitempty"`
}

func (s *server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, verifyResponse{Error: "invalid JSON body"})
		return
	}
	if len(req.Emails) == 0 {
		writeJSON(w, http.StatusOK, verifyResponse{Results: []prober.Result{}})
		return
	}
	if len(req.Emails) > maxBatch {
		writeJSON(w, http.StatusBadRequest, verifyResponse{
			Error: fmt.Sprintf("batch too large: %d > %d", len(req.Emails), maxBatch),
		})
		return
	}

	s.batchesTotal.Add(1)
	started := time.Now()

	results, err := s.prober.Verify(r.Context(), req.Emails)

	for _, res := range results {
		s.checksTotal.Add(1)
		switch res.Status {
		case prober.StatusSafe:
			s.safeTotal.Add(1)
		case prober.StatusInvalid:
			s.invalidTotal.Add(1)
		case prober.StatusRisky:
			s.riskyTotal.Add(1)
		default:
			s.unknownTotal.Add(1)
		}
	}

	if errors.Is(err, prober.ErrAllCooling) {
		s.blocksTotal.Add(1)
		s.log.Warn("all verifier IPs cooling", "batch", len(req.Emails))
		// 503 is the contract with the worker: it means "route this batch to
		// the paid fallback", not "retry me".
		writeJSON(w, http.StatusServiceUnavailable, verifyResponse{
			Results: results, AllCooling: true, Error: "all verifier IPs are cooling",
		})
		return
	}

	s.log.Info("batch verified",
		"count", len(results), "elapsed_ms", time.Since(started).Milliseconds())
	writeJSON(w, http.StatusOK, verifyResponse{Results: results})
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	active, err := s.ips.ActiveCount(r.Context(), s.cfg.IPs)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"healthy": false, "error": err.Error(),
		})
		return
	}
	// Healthy-but-zero-usable-IPs is reported as healthy:true with
	// active_ips:0 so the caller can distinguish "service is down" from
	// "service is up but every IP is burnt". They need different responses.
	writeJSON(w, http.StatusOK, map[string]any{
		"healthy":     true,
		"active_ips":  active,
		"total_ips":   len(s.cfg.IPs),
		"helo_domain": s.cfg.HeloDomain,
	})
}

// handleDebugDial reports what the prober's own dialler experiences.
//
// It is bound to the same host-networked process, uses the same Dialer settings
// and the same LocalAddr binding as a real probe, so its answer applies to the
// verifier directly. A shell probe from the host does not — different resolver,
// different family selection, different source address.
//
//	GET /debug/dial?host=aspmx.l.google.com&port=25&family=ipv4&n=10&gap_ms=3000&banner=1
//
// family may be ipv4, ipv6, or omitted for both.
func (s *server) handleDebugDial(w http.ResponseWriter, r *http.Request) {
	// This endpoint opens an arbitrary outbound TCP connection from our public
	// IP, so exposing it to the internet would hand anyone a port scanner
	// wearing our address — and this service listens on 0.0.0.0 because it runs
	// with host networking. Workers reach it over the Docker bridge gateway
	// (RFC1918), never from off-box, so private and loopback sources are the
	// whole legitimate audience.
	if !isPrivateCaller(r.RemoteAddr) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "debug endpoints are reachable from private addresses only",
		})
		return
	}

	q := r.URL.Query()

	host := strings.TrimSpace(q.Get("host"))
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "host is required"})
		return
	}

	port := strings.TrimSpace(q.Get("port"))
	if port == "" {
		port = "25"
	}

	var families []string
	if fam := strings.TrimSpace(q.Get("family")); fam != "" {
		families = []string{fam}
	}

	n := atoiOr(q.Get("n"), 1)
	if n < 1 {
		n = 1
	}
	if n > 60 {
		n = 60 // this opens real connections to real mail servers; keep it bounded
	}
	gap := atoiOr(q.Get("gap_ms"), 3000)
	banner := q.Get("banner") == "1"

	// Its own timeout, independent of the caller's, so a long sweep is not cut
	// off halfway and reported as a network failure.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()

	rounds := s.prober.DebugSweep(ctx, host, port, families, n, gap, banner)

	okCount, total := 0, 0
	for _, round := range rounds {
		okCount += round.OKCount
		total += round.Total
		for _, at := range round.Attempts {
			s.log.Info("debug dial", "detail", at.String())
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"host": host, "port": port, "rounds": rounds,
		"ok": okCount, "total": total,
	})
}

// isPrivateCaller reports whether a request came from loopback or an RFC1918 /
// link-local address — i.e. from this host or a container on it.
func isPrivateCaller(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func atoiOr(raw string, fallback int) int {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return v
}

func (s *server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	active, _ := s.ips.ActiveCount(r.Context(), s.cfg.IPs)
	st := s.prober.Stats()

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, `# HELP verifysvc_checks_total Addresses checked.
# TYPE verifysvc_checks_total counter
verifysvc_checks_total %d
# HELP verifysvc_results_total Verdicts by status.
# TYPE verifysvc_results_total counter
verifysvc_results_total{status="safe"} %d
verifysvc_results_total{status="invalid"} %d
verifysvc_results_total{status="risky"} %d
verifysvc_results_total{status="unknown"} %d
# HELP verifysvc_batches_total Batches received.
# TYPE verifysvc_batches_total counter
verifysvc_batches_total %d
# HELP verifysvc_all_cooling_total Times every IP was cooling at once.
# TYPE verifysvc_all_cooling_total counter
verifysvc_all_cooling_total %d
# HELP verifysvc_active_ips Currently usable outbound IPs.
# TYPE verifysvc_active_ips gauge
verifysvc_active_ips %d
# HELP verifysvc_dial_attempts_total Outbound port-25 connections attempted.
# TYPE verifysvc_dial_attempts_total counter
verifysvc_dial_attempts_total %d
# HELP verifysvc_dial_failures_total Dials that never completed (timeout, refused, unreachable).
# TYPE verifysvc_dial_failures_total counter
verifysvc_dial_failures_total %d
# HELP verifysvc_mx_backoffs_total MX hosts backed off after consecutive dial failures.
# TYPE verifysvc_mx_backoffs_total counter
verifysvc_mx_backoffs_total %d
# HELP verifysvc_ip_cool_triggers_total Times dial failures across MX hosts cooled an IP.
# TYPE verifysvc_ip_cool_triggers_total counter
verifysvc_ip_cool_triggers_total %d
# HELP verifysvc_mx_backed_off MX hosts currently inside their backoff window.
# TYPE verifysvc_mx_backed_off gauge
verifysvc_mx_backed_off %d
# HELP verifysvc_connections_in_flight Outbound port-25 connections open right now.
# TYPE verifysvc_connections_in_flight gauge
verifysvc_connections_in_flight %d
`,
		s.checksTotal.Load(), s.safeTotal.Load(), s.invalidTotal.Load(),
		s.riskyTotal.Load(), s.unknownTotal.Load(),
		s.batchesTotal.Load(), s.blocksTotal.Load(), active,
		st.DialAttempts, st.DialFailures, st.MXBackoffs, st.IPCoolTriggers,
		st.MXBackedOffNow, st.InFlight)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}
