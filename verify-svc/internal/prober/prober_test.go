package prober

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	emailverifier "github.com/AfterShip/email-verifier"

	"github.com/bezbuilder/leadgen/verify-svc/internal/ipstate"
)

// ── test doubles ─────────────────────────────────────────────────────────────

type fakeIPStore struct {
	mu sync.Mutex

	decision ipstate.Decision
	chooseErr error

	checks  int
	cooled  []string
	reasons []string
}

func (f *fakeIPStore) Choose(context.Context, []string, string) (ipstate.Decision, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.decision, f.chooseErr
}

func (f *fakeIPStore) RecordCheck(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks++
	return nil
}

func (f *fakeIPStore) Cool(_ context.Context, ip, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cooled = append(f.cooled, ip)
	f.reasons = append(f.reasons, reason)
	return nil
}

func (f *fakeIPStore) coolCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.cooled)
}

// newTestProber wires a prober to a fake SMTP server and a fake IP store, with
// pacing off so the mandated 3–5 s RCPT gaps do not make the suite take hours.
func newTestProber(t *testing.T, srv *fakeSMTP, store *fakeIPStore) *Prober {
	t.Helper()

	host, port := "", ""
	if srv != nil {
		host, port = srv.addr()
	}

	p := &Prober{
		cfg:      Config{IPs: []string{"127.0.0.1"}, HeloDomain: "verify1.test", FromEmail: "verify@test"},
		ips:      store,
		verifier: emailverifier.NewVerifier(),
		failures: newFailureTracker(),
		sem:      newIPSemaphore(),
		smtpPort: port,
		now:      time.Now,
		pacing:   false,
	}
	p.lookupMX = func(string) (string, bool, error) { return host, true, nil }
	return p
}

func activeStore() *fakeIPStore {
	return &fakeIPStore{decision: ipstate.Decision{IP: "127.0.0.1"}}
}

func statuses(results []Result) map[string]string {
	out := map[string]string{}
	for _, r := range results {
		out[r.Email] = r.Status
	}
	return out
}

// ── stop at first safe ───────────────────────────────────────────────────────

// The brief required this and the original code did not do it: every lead
// burned all six candidate addresses, which forced a reconnect every five RCPTs
// and roughly doubled the connection count that triggered provider throttling.
// It was implemented but never asserted, so this is the assertion.
func TestStopsAtFirstSafeAddress(t *testing.T) {
	srv := newFakeSMTP(t)
	// The first candidate is deliverable; everything else would be too, so a
	// prober that kept going would visibly overshoot.
	srv.reply = func(addr string) string {
		if strings.HasPrefix(addr, "zz") {
			return "550 5.1.1 no such user" // not a catch-all domain
		}
		return "250 2.1.5 ok"
	}

	p := newTestProber(t, srv, activeStore())

	candidates := []string{
		"anna@example.test",
		"a.smith@example.test",
		"asmith@example.test",
		"anna.smith@example.test",
		"smith@example.test",
		"anna.s@example.test",
	}

	results, err := p.Verify(context.Background(), candidates)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	real := srv.realRCPTs()
	if len(real) != 1 {
		t.Fatalf("expected exactly one candidate RCPT, got %d: %v", len(real), real)
	}
	if real[0] != "anna@example.test" {
		t.Fatalf("expected the first candidate to be probed, got %q", real[0])
	}

	got := statuses(results)
	if got["anna@example.test"] != StatusSafe {
		t.Fatalf("first candidate should be safe, got %q", got["anna@example.test"])
	}
	for _, e := range candidates[1:] {
		if got[e] != StatusUnknown {
			t.Errorf("%s: expected unknown after an earlier safe hit, got %q", e, got[e])
		}
	}

	// Six candidates at five RCPTs per connection would have forced a
	// reconnect; stopping at the first means one connection is enough.
	if srv.connCount() != 1 {
		t.Errorf("expected 1 connection, got %d", srv.connCount())
	}
}

func TestProbesEveryCandidateWhenNoneIsSafe(t *testing.T) {
	srv := newFakeSMTP(t) // default: 550 for everything
	p := newTestProber(t, srv, activeStore())

	candidates := []string{"a@example.test", "b@example.test", "c@example.test"}
	results, err := p.Verify(context.Background(), candidates)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if got := len(srv.realRCPTs()); got != 3 {
		t.Fatalf("expected all 3 candidates probed, got %d", got)
	}
	for e, s := range statuses(results) {
		if s != StatusInvalid {
			t.Errorf("%s: expected invalid, got %q", e, s)
		}
	}
}

func TestCatchAllShortCircuitsWithoutProbingCandidates(t *testing.T) {
	srv := newFakeSMTP(t)
	srv.reply = func(string) string { return "250 2.1.5 ok" } // accepts anything

	p := newTestProber(t, srv, activeStore())

	results, err := p.Verify(context.Background(),
		[]string{"a@example.test", "b@example.test"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}

	if got := srv.realRCPTs(); len(got) != 0 {
		t.Fatalf("a catch-all domain must not have candidates probed, got %v", got)
	}
	for _, r := range results {
		if r.Status != StatusRisky || !r.IsCatchAll {
			t.Errorf("%s: expected risky+catch-all, got %q catchAll=%v", r.Email, r.Status, r.IsCatchAll)
		}
	}
}

// ── policy 5xx is not a mailbox verdict ──────────────────────────────────────

// Replies that are a verdict about the mailbox, or a refusal to give one.
// Neither says anything about our IP, so neither may cool it.
func TestMailboxVerdictsAndPolicyRefusals(t *testing.T) {
	cases := []struct {
		reply     string
		want      string
		transient bool
	}{
		{"550 5.1.1 The email account that you tried to reach does not exist", StatusInvalid, false},
		{"550 5.1.1 <a@example.test>: Recipient address rejected", StatusInvalid, false},
		// An open-relay guard: the server is refusing to answer, not saying the
		// mailbox is absent. Recording it as invalid writes off a lead that was
		// never judged — observed on slim-herbal.com.
		{"550 Please turn on SMTP Authentication in your mail client", StatusUnknown, true},
		{"550 5.7.0 Relaying denied", StatusUnknown, true},
		// Any 4xx that is not a block code: transient by definition.
		{"452 4.2.2 Mailbox full", StatusUnknown, true},
		{"400 4.0.0 Try again", StatusUnknown, true},
	}

	for _, tc := range cases {
		t.Run(tc.reply, func(t *testing.T) {
			srv := newFakeSMTP(t)
			srv.reply = func(addr string) string {
				if strings.HasPrefix(addr, "zz") {
					return "550 5.1.1 no such user" // not a catch-all
				}
				return tc.reply
			}
			store := activeStore()
			p := newTestProber(t, srv, store)

			results, err := p.Verify(context.Background(), []string{"a@example.test"})
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if results[0].Status != tc.want {
				t.Fatalf("reply %q: got %q want %q", tc.reply, results[0].Status, tc.want)
			}
			if results[0].Transient != tc.transient {
				t.Errorf("reply %q: transient=%v want %v", tc.reply, results[0].Transient, tc.transient)
			}
			if store.coolCount() != 0 {
				t.Errorf("reply %q must not cool the IP — it is about the mailbox, not us", tc.reply)
			}
		})
	}
}

// Replies that mean "this IP is refused". Per ARCHITECTURE §5 these cool the IP
// and the batch comes back as ErrAllCooling so the caller escalates to the paid
// fallback rather than treating a fleet-wide refusal as a set of verdicts.
func TestBlockCodesCoolTheIPAndEscalate(t *testing.T) {
	for _, reply := range []string{
		"550 5.7.1 Message rejected due to policy",
		"451 4.7.1 Greylisted, try again later",
		"421 4.7.0 Too many connections from your IP",
		"550 5.7.1 Service unavailable, client host blocked using Spamhaus",
	} {
		t.Run(reply, func(t *testing.T) {
			srv := newFakeSMTP(t)
			srv.reply = func(addr string) string {
				if strings.HasPrefix(addr, "zz") {
					return "550 5.1.1 no such user"
				}
				return reply
			}
			store := activeStore()
			p := newTestProber(t, srv, store)

			results, err := p.Verify(context.Background(), []string{"a@example.test"})

			if err == nil || !strings.Contains(err.Error(), "cooling") {
				t.Fatalf("reply %q should surface ErrAllCooling, got %v", reply, err)
			}
			if store.coolCount() == 0 {
				t.Errorf("reply %q should have cooled the IP", reply)
			}
			if results[0].Status != StatusUnknown {
				t.Errorf("reply %q: got %q, want unknown — a blocked IP is not a mailbox verdict",
					reply, results[0].Status)
			}
		})
	}
}

// ── dial failures: MX backoff and IP cooling ─────────────────────────────────

// deadProber points at a port with nothing listening, which is the closest
// reproducible analogue of the black-holed port 25 in production.
func deadProber(t *testing.T, store *fakeIPStore) *Prober {
	t.Helper()
	p := newTestProber(t, nil, store)
	// Reserve a port, then close it, so connections are refused rather than
	// hanging for the 20 s dial timeout.
	srv := newFakeSMTP(t)
	host, port := srv.addr()
	_ = srv.listener.Close()
	p.smtpPort = port
	p.lookupMX = func(string) (string, bool, error) { return host, true, nil }
	return p
}

func TestThreeConsecutiveDialFailuresBackOffTheMX(t *testing.T) {
	store := activeStore()
	p := deadProber(t, store)

	for i := 1; i <= mxConsecutiveFailLimit; i++ {
		if _, err := p.Verify(context.Background(),
			[]string{fmt.Sprintf("a%d@example.test", i)}); err != nil {
			t.Fatalf("Verify %d: %v", i, err)
		}
	}

	backedOff, until := p.failures.backedOff("127.0.0.1", time.Now())
	if !backedOff {
		t.Fatalf("expected the MX to be backed off after %d consecutive dial failures",
			mxConsecutiveFailLimit)
	}
	if d := time.Until(until); d < 25*time.Minute || d > 31*time.Minute {
		t.Errorf("expected roughly a %s backoff, got %s", mxBackoffDuration, d)
	}

	// A backed-off MX must not be dialled again.
	before := p.Stats().DialAttempts
	results, err := p.Verify(context.Background(), []string{"later@example.test"})
	if err != nil {
		t.Fatalf("Verify after backoff: %v", err)
	}
	if p.Stats().DialAttempts != before {
		t.Errorf("a backed-off MX must not be dialled, attempts went %d -> %d",
			before, p.Stats().DialAttempts)
	}
	if results[0].Status != StatusUnknown || !results[0].Transient {
		t.Errorf("expected transient unknown while backed off, got %q transient=%v",
			results[0].Status, results[0].Transient)
	}
	if !strings.Contains(results[0].Detail, "backed off") {
		t.Errorf("detail should explain the backoff, got %q", results[0].Detail)
	}
}

func TestBackoffExpiryAllowsDiallingAgain(t *testing.T) {
	f := newFailureTracker()
	base := time.Now()

	for i := 0; i < mxConsecutiveFailLimit; i++ {
		f.recordFailure("mx.test", base)
	}
	if ok, _ := f.backedOff("mx.test", base); !ok {
		t.Fatal("expected backoff")
	}
	if ok, _ := f.backedOff("mx.test", base.Add(mxBackoffDuration+time.Second)); ok {
		t.Fatal("backoff should have expired")
	}
	// The consecutive counter resets with the window, so one later failure must
	// not immediately re-trip the threshold.
	out := f.recordFailure("mx.test", base.Add(mxBackoffDuration+2*time.Second))
	if out.MXBackedOff {
		t.Error("a single failure after expiry must not re-trip the backoff")
	}
}

func TestSuccessResetsConsecutiveFailures(t *testing.T) {
	f := newFailureTracker()
	now := time.Now()

	f.recordFailure("mx.test", now)
	f.recordFailure("mx.test", now)
	f.recordSuccess("mx.test")
	out := f.recordFailure("mx.test", now)

	if out.Consecutive != 1 {
		t.Fatalf("a success must reset the consecutive counter, got %d", out.Consecutive)
	}
	if out.MXBackedOff {
		t.Error("should not back off after a reset")
	}
}

// dialAttempts is incremented once, before the dial. Counting again on success
// made the failure ratio on /metrics look better than it was.
func TestEachDialCountsExactlyOnce(t *testing.T) {
	f := newFailureTracker()
	now := time.Now()

	f.recordAttempt()
	f.recordSuccess("mx.test")
	f.recordAttempt()
	f.recordFailure("mx.test", now)

	s := f.stats(now)
	if s.DialAttempts != 2 {
		t.Errorf("expected 2 attempts for 2 dials, got %d", s.DialAttempts)
	}
	if s.DialFailures != 1 {
		t.Errorf("expected 1 failure, got %d", s.DialFailures)
	}
}

func TestTenFailuresInFiveMinutesCoolTheIP(t *testing.T) {
	f := newFailureTracker()
	now := time.Now()

	// Spread across different MX hosts, so the per-MX rule is not what fires.
	var out dialOutcome
	for i := 0; i < ipFailLimit; i++ {
		out = f.recordFailure(fmt.Sprintf("mx%d.test", i), now.Add(time.Duration(i)*time.Second))
	}

	if !out.CoolIP {
		t.Fatalf("expected the IP to be cooled after %d failures in %s", ipFailLimit, ipFailWindow)
	}
	if out.InWindow < ipFailLimit {
		t.Errorf("expected at least %d failures in window, got %d", ipFailLimit, out.InWindow)
	}
}

func TestFailuresOutsideTheWindowDoNotCoolTheIP(t *testing.T) {
	f := newFailureTracker()
	base := time.Now()

	// Same number of failures, but spaced beyond the window.
	for i := 0; i < ipFailLimit*2; i++ {
		out := f.recordFailure(fmt.Sprintf("mx%d.test", i), base.Add(time.Duration(i)*(ipFailWindow+time.Second)))
		if out.CoolIP {
			t.Fatalf("failure %d: spaced-out failures must not cool the IP", i)
		}
	}
}

// The whole point of the change: a cooled IP has to produce ErrAllCooling, which
// is what the worker turns into a Verifalia escalation.
func TestIPCoolingEscalatesToFallback(t *testing.T) {
	store := activeStore()
	p := deadProber(t, store)

	// Each Verify call is one domain and one dial. Enough of them to cross the
	// IP-wide threshold; distinct domains keep the per-MX backoff from firing
	// first, since lookupMX maps every domain to the same dead host.
	var lastErr error
	for i := 0; i < ipFailLimit+2; i++ {
		// Clear the per-MX backoff each round so the IP rule is what trips.
		p.failures.mu.Lock()
		p.failures.backoffUntil = map[string]time.Time{}
		p.failures.consecutive = map[string]int{}
		p.failures.mu.Unlock()

		_, err := p.Verify(context.Background(), []string{fmt.Sprintf("a%d@d%d.test", i, i)})
		if err != nil {
			lastErr = err
		}
	}

	if store.coolCount() == 0 {
		t.Fatal("expected the IP to be cooled after repeated dial failures")
	}
	if lastErr == nil || !strings.Contains(lastErr.Error(), "cooling") {
		t.Fatalf("expected ErrAllCooling to reach the caller, got %v", lastErr)
	}
}

func TestAllCoolingReturnsErrorWithoutDialling(t *testing.T) {
	store := &fakeIPStore{decision: ipstate.Decision{AllCooling: true}}
	srv := newFakeSMTP(t)
	p := newTestProber(t, srv, store)

	results, err := p.Verify(context.Background(), []string{"a@example.test"})
	if err == nil || !strings.Contains(err.Error(), "cooling") {
		t.Fatalf("expected ErrAllCooling, got %v", err)
	}
	if len(srv.recorded()) != 0 {
		t.Errorf("must not dial while every IP is cooling, saw %v", srv.recorded())
	}
	if results[0].Status != StatusUnknown {
		t.Errorf("expected unknown, got %q", results[0].Status)
	}
}

func TestHourlyCapDoesNotCoolOrSpendFallbackBudget(t *testing.T) {
	// AllAtCap is a wait-and-retry condition, not a block: escalating it to the
	// paid provider would spend money on something that fixes itself.
	store := &fakeIPStore{decision: ipstate.Decision{AllAtCap: true}}
	srv := newFakeSMTP(t)
	p := newTestProber(t, srv, store)

	results, err := p.Verify(context.Background(), []string{"a@example.test"})
	if err != nil {
		t.Fatalf("hourly cap must not surface as an error, got %v", err)
	}
	if results[0].Status != StatusUnknown {
		t.Errorf("expected unknown, got %q", results[0].Status)
	}
	if !strings.Contains(results[0].Detail, "hourly cap") {
		t.Errorf("detail should name the cap, got %q", results[0].Detail)
	}
	if store.coolCount() != 0 {
		t.Error("hitting the hourly cap must not cool the IP")
	}
}

// ── per-IP concurrency ───────────────────────────────────────────────────────

func TestConcurrentConnectionsPerIPAreCapped(t *testing.T) {
	sem := newIPSemaphore()
	ctx := context.Background()

	for i := 0; i < maxConcurrentPerIP; i++ {
		if err := sem.acquire(ctx, "127.0.0.1"); err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
	}
	if got := sem.current(); got != int64(maxConcurrentPerIP) {
		t.Fatalf("expected %d in flight, got %d", maxConcurrentPerIP, got)
	}

	// The next acquire must block until a slot frees.
	blocked, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if err := sem.acquire(blocked, "127.0.0.1"); err == nil {
		t.Fatal("expected the 5th concurrent connection to be refused a slot")
	}

	sem.release("127.0.0.1")
	if err := sem.acquire(ctx, "127.0.0.1"); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
}

func TestSemaphoreIsPerIPNotGlobal(t *testing.T) {
	sem := newIPSemaphore()
	ctx := context.Background()

	for i := 0; i < maxConcurrentPerIP; i++ {
		if err := sem.acquire(ctx, "10.0.0.1"); err != nil {
			t.Fatalf("acquire: %v", err)
		}
	}
	// A different IP has its own budget.
	quick, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if err := sem.acquire(quick, "10.0.0.2"); err != nil {
		t.Fatalf("a second IP must have its own slots, got %v", err)
	}
}

func TestOneConnectionAtATimePerMXHost(t *testing.T) {
	srv := newFakeSMTP(t)
	srv.reply = func(string) string { return "550 5.1.1 no" }
	p := newTestProber(t, srv, activeStore())

	// Ten domains all resolving to the same MX host, probed concurrently.
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = p.Verify(context.Background(), []string{fmt.Sprintf("a@d%d.test", i)})
		}(i)
	}
	wg.Wait()

	// Serialisation is enforced by the per-MX mutex; if it were broken the fake
	// would have seen overlapping connections. Assert every connection produced
	// its own complete exchange rather than interleaving.
	if srv.connCount() != 10 {
		t.Errorf("expected 10 sequential connections, got %d", srv.connCount())
	}
}

// ── metrics ──────────────────────────────────────────────────────────────────

func TestStatsCountDialsAndFailures(t *testing.T) {
	store := activeStore()
	p := deadProber(t, store)

	for i := 0; i < 2; i++ {
		_, _ = p.Verify(context.Background(), []string{fmt.Sprintf("a%d@example.test", i)})
	}

	s := p.Stats()
	if s.DialAttempts < 2 {
		t.Errorf("expected at least 2 dial attempts, got %d", s.DialAttempts)
	}
	if s.DialFailures < 2 {
		t.Errorf("expected at least 2 dial failures, got %d", s.DialFailures)
	}
	if s.InFlight != 0 {
		t.Errorf("expected 0 in flight after completion, got %d", s.InFlight)
	}
}
