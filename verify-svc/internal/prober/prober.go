// Package prober performs the SMTP RCPT probe.
//
// Why this is ours and not the library's: AfterShip/email-verifier dials a
// fresh connection for every address and exposes no hook for the local
// address, so neither "≤5 RCPT per session" nor "bind outbound to a specific
// IP" is reachable through its API. Both are hard requirements here — the first
// because one connection per address is the fastest way to get rate-limited,
// the second because IP rotation is the whole point of running our own IPs.
//
// The library is still used, for the parts it is genuinely good at: syntax
// parsing, MX lookup, and its maintained disposable / role / free-provider
// lists. Those lists are the reason to depend on it at all.
package prober

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/smtp"
	"sort"
	"strings"
	"sync"
	"time"

	emailverifier "github.com/AfterShip/email-verifier"

	"github.com/bezbuilder/leadgen/verify-svc/internal/ipstate"
)

// Timing, per the brief. These are deliberately slow: verification throughput
// is capped by politeness, not by CPU.
const (
	minRCPTGap     = 3 * time.Second
	maxRCPTGap     = 5 * time.Second
	maxRCPTPerConn = 5
	dialTimeout    = 15 * time.Second
	cmdTimeout     = 20 * time.Second
)

// Status values returned to the worker.
const (
	StatusSafe    = "safe"
	StatusInvalid = "invalid"
	StatusRisky   = "risky"
	StatusUnknown = "unknown"
)

// Result is one address's verdict.
type Result struct {
	Email        string `json:"email"`
	Status       string `json:"status"`
	IsCatchAll   bool   `json:"is_catch_all"`
	IsDisposable bool   `json:"is_disposable"`
	IsRole       bool   `json:"is_role"`
	LatencyMS    int64  `json:"latency_ms"`
	Detail       string `json:"detail,omitempty"`
}

// Config is the service's static configuration.
type Config struct {
	IPs        []string
	HeloDomain string
	FromEmail  string
}

// Prober verifies addresses under per-MX serialisation and per-IP limits.
type Prober struct {
	cfg      Config
	ips      *ipstate.Store
	verifier *emailverifier.Verifier

	// One in-flight connection per MX host, as required. A mutex per host
	// rather than one global lock, so different providers proceed in parallel
	// — the constraint is per-MX, not service-wide.
	mxLocks sync.Map // map[string]*sync.Mutex
}

func New(cfg Config, ips *ipstate.Store) *Prober {
	// SMTP checking is done by this package, so the library is configured for
	// metadata only. EnableSMTPCheck is deliberately NOT set.
	v := emailverifier.NewVerifier().
		EnableDomainSuggest()

	return &Prober{cfg: cfg, ips: ips, verifier: v}
}

func (p *Prober) lockFor(mx string) *sync.Mutex {
	actual, _ := p.mxLocks.LoadOrStore(mx, &sync.Mutex{})
	return actual.(*sync.Mutex)
}

// ErrAllCooling means every configured IP is blocked; the caller should route
// the batch to the paid fallback rather than returning a fabricated verdict.
var ErrAllCooling = errors.New("all verifier IPs are cooling")

// Verify checks a batch, grouped by domain and then by MX host.
func (p *Prober) Verify(ctx context.Context, emails []string) ([]Result, error) {
	byDomain := map[string][]string{}
	results := map[string]*Result{}

	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" {
			continue
		}

		syntax := p.verifier.ParseAddress(email)
		res := &Result{Email: email}
		results[email] = res

		if !syntax.Valid {
			res.Status = StatusInvalid
			res.Detail = "malformed address"
			continue
		}

		res.IsRole = p.verifier.IsRoleAccount(syntax.Username)
		res.IsDisposable = p.verifier.IsDisposable(syntax.Domain)

		// A disposable address is never worth an SMTP round trip.
		if res.IsDisposable {
			res.Status = StatusInvalid
			res.Detail = "disposable domain"
			continue
		}

		byDomain[syntax.Domain] = append(byDomain[syntax.Domain], email)
	}

	// Track whether any domain got a real answer. If every domain that needed
	// SMTP was turned away because the IPs are cooling, the whole batch has to
	// come back as ErrAllCooling so the worker escalates to the paid fallback
	// rather than treating a fleet-wide outage as a set of verdicts.
	domainsNeedingSMTP := 0
	domainsBlocked := 0

	for domain, addrs := range byDomain {
		mx, err := p.verifier.CheckMX(domain)
		if err != nil || mx == nil || !mx.HasMXRecord {
			// A definitive answer that costs no SMTP, so it does not count
			// toward the cooling tally either way.
			for _, e := range addrs {
				results[e].Status = StatusInvalid
				results[e].Detail = "no MX record"
			}
			continue
		}

		domainsNeedingSMTP++
		host := primaryMX(mx)

		cooled, err := p.probeDomain(ctx, domain, host, addrs, results)
		if err != nil && errors.Is(err, ErrAllCooling) {
			cooled = true
		}
		if cooled {
			domainsBlocked++
			for _, e := range addrs {
				if results[e].Status == "" {
					results[e].Status = StatusUnknown
					results[e].Detail = "all verifier IPs cooling"
				}
			}
		}
	}

	out := make([]Result, 0, len(results))
	for _, r := range results {
		if r.Status == "" {
			r.Status = StatusUnknown
		}
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Email < out[j].Email })

	if domainsNeedingSMTP > 0 && domainsBlocked == domainsNeedingSMTP {
		return out, ErrAllCooling
	}
	return out, nil
}

// probeDomain opens at most a handful of sessions to one MX host and probes
// every address on that domain. Returns true when it gave up because no IP was
// available.
func (p *Prober) probeDomain(
	ctx context.Context, domain, mxHost string, addrs []string, results map[string]*Result,
) (bool, error) {
	// One connection at a time to this MX, across the whole service.
	lock := p.lockFor(mxHost)
	lock.Lock()
	defer lock.Unlock()

	decision, err := p.ips.Choose(ctx, p.cfg.IPs, mxHost)
	if err != nil {
		return false, err
	}
	if decision.AllCooling {
		return true, ErrAllCooling
	}
	if decision.IP == "" {
		// Hourly cap reached. Not a block — waiting fixes it, so this must not
		// burn paid Verifalia budget.
		for _, e := range addrs {
			results[e].Status = StatusUnknown
			results[e].Detail = "hourly cap reached for this MX"
		}
		return false, nil
	}

	started := time.Now()
	session, err := p.dial(ctx, decision.IP, mxHost)
	if err != nil {
		reason := err.Error()
		if ipstate.IsBlockResponse(reason) {
			_ = p.ips.Cool(ctx, decision.IP, reason)
			return true, nil
		}
		for _, e := range addrs {
			results[e].Status = StatusUnknown
			results[e].Detail = "connect failed: " + truncate(reason, 200)
		}
		return false, nil
	}
	// Closes whichever session is current at return. A plain `defer
	// session.close()` would bind the original pointer and leak the connection
	// opened by the reconnect below.
	defer func() { session.close() }()

	// ── Catch-all probe ───────────────────────────────────────────────────────
	//
	// A random local part that cannot exist. If the server accepts it, every
	// RCPT on this domain is meaningless, so we stop and mark the whole domain
	// catch-all rather than manufacturing confident-looking guesses.
	probe := fmt.Sprintf("zz%dnx@%s", rand.Int63(), domain)
	accepted, reply, err := session.rcpt(probe)
	_ = p.ips.RecordCheck(ctx, decision.IP)

	if err != nil && ipstate.IsBlockResponse(reply) {
		_ = p.ips.Cool(ctx, decision.IP, reply)
		for _, e := range addrs {
			results[e].Status = StatusUnknown
			results[e].Detail = "IP blocked during catch-all probe"
		}
		return true, nil
	}

	if accepted {
		for _, e := range addrs {
			results[e].Status = StatusRisky
			results[e].IsCatchAll = true
			results[e].Detail = "catch-all domain"
			results[e].LatencyMS = time.Since(started).Milliseconds()
		}
		return false, nil
	}

	// ── Per-address RCPT ──────────────────────────────────────────────────────
	sent := 1 // the catch-all probe counts toward this session's budget
	for _, email := range addrs {
		if sent >= maxRCPTPerConn {
			session.close()
			jitterSleep(ctx)
			session, err = p.dial(ctx, decision.IP, mxHost)
			if err != nil {
				results[email].Status = StatusUnknown
				results[email].Detail = "reconnect failed"
				continue
			}
			sent = 0
		}

		jitterSleep(ctx)
		addrStarted := time.Now()
		ok, reply, rcptErr := session.rcpt(email)
		sent++
		_ = p.ips.RecordCheck(ctx, decision.IP)

		res := results[email]
		res.LatencyMS = time.Since(addrStarted).Milliseconds()

		switch {
		case rcptErr != nil && ipstate.IsBlockResponse(reply):
			_ = p.ips.Cool(ctx, decision.IP, reply)
			res.Status = StatusUnknown
			res.Detail = "IP blocked: " + truncate(reply, 200)
			// Everything still unprobed on this domain is unknown too.
			for _, rest := range addrs {
				if results[rest].Status == "" {
					results[rest].Status = StatusUnknown
					results[rest].Detail = "aborted after IP block"
				}
			}
			return true, nil

		case ok:
			res.Status = StatusSafe
			res.Detail = truncate(reply, 200)

		case isPermanentReject(reply):
			res.Status = StatusInvalid
			res.Detail = truncate(reply, 200)

		default:
			// A temporary failure that is not a block — greylisting on a single
			// address, a full mailbox. Honest answer is "we don't know".
			res.Status = StatusUnknown
			res.Detail = truncate(reply, 200)
		}
	}

	return false, nil
}

// isPermanentReject distinguishes "no such mailbox" from everything else.
func isPermanentReject(reply string) bool {
	trimmed := strings.TrimSpace(reply)
	if len(trimmed) < 3 {
		return false
	}
	// 5xx, but not 5.7.1 (that is a policy block, handled as a block above).
	return strings.HasPrefix(trimmed, "5") && !strings.Contains(trimmed, "5.7.1")
}

func primaryMX(mx *emailverifier.Mx) string {
	if mx == nil || len(mx.Records) == 0 {
		return ""
	}
	best := mx.Records[0]
	for _, r := range mx.Records {
		if r.Pref < best.Pref {
			best = r
		}
	}
	return strings.TrimSuffix(best.Host, ".")
}

// jitterSleep waits 3–5 s, the mandated inter-RCPT gap.
func jitterSleep(ctx context.Context) {
	d := minRCPTGap + time.Duration(rand.Int63n(int64(maxRCPTGap-minRCPTGap)))
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ── session ──────────────────────────────────────────────────────────────────

type session struct {
	client *smtp.Client
	conn   net.Conn
}

// dial opens an SMTP session bound to a specific local IP.
//
// Binding the local address is the mechanism behind IP rotation: the container
// runs with host networking so the VPS's public IPs are directly bindable.
//
// The network is pinned to the address family of the bound IP, and that is not
// cosmetic. With plain "tcp", Go resolves the MX to whichever family it prefers
// — on a dual-stack host that is usually IPv6 — and then fails the dial with a
// mismatched-address-family error because LocalAddr is IPv4. Measured on
// srv607166: gmail-smtp-in.l.google.com answered over IPv6 (`2a02:4780:...`)
// while outlook answered over IPv4, so unpinned dialling would have broken
// every Gmail probe while appearing to work for Microsoft.
//
// Pinning also keeps reputation on the address we actually configured. An
// accidental IPv6 egress carries its own PTR and SPF, neither of which is set
// up, so those probes would be judged on an unconfigured identity.
func (p *Prober) dial(ctx context.Context, localIP, mxHost string) (*session, error) {
	local := net.ParseIP(localIP)
	if local == nil {
		return nil, fmt.Errorf("VERIFY_IPS contains an unparseable address: %q", localIP)
	}

	network := "tcp4"
	if local.To4() == nil {
		network = "tcp6"
	}

	dialer := &net.Dialer{
		Timeout:   dialTimeout,
		LocalAddr: &net.TCPAddr{IP: local},
	}

	conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(mxHost, "25"))
	if err != nil {
		return nil, fmt.Errorf("dial %s from %s over %s: %w", mxHost, localIP, network, err)
	}
	_ = conn.SetDeadline(time.Now().Add(cmdTimeout))

	client, err := smtp.NewClient(conn, mxHost)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := client.Hello(p.cfg.HeloDomain); err != nil {
		_ = client.Close()
		return nil, err
	}
	if err := client.Mail(p.cfg.FromEmail); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &session{client: client, conn: conn}, nil
}

// rcpt issues one RCPT TO and returns whether it was accepted plus the raw reply.
func (s *session) rcpt(email string) (bool, string, error) {
	_ = s.conn.SetDeadline(time.Now().Add(cmdTimeout))
	err := s.client.Rcpt(email)
	if err == nil {
		return true, "250 accepted", nil
	}
	return false, err.Error(), err
}

func (s *session) close() {
	if s == nil || s.client == nil {
		return
	}
	_ = s.client.Quit()
	_ = s.client.Close()
}
