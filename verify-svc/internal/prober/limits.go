package prober

// Connection-level limits and failure tracking.
//
// The gap this closes: `ipstate.IsBlockResponse` only ever sees SMTP reply
// text, and a dial that times out carries no SMTP code at all. So the fleet
// could dial a black-holed port 25 several hundred times, classify every result
// `unknown`, and never once cool the IP or escalate to the paid fallback. That
// is precisely what produced a run of 318 checks with 293 unknowns and zero
// Tier A rows: the safety net existed and nothing could trigger it.
//
// Two thresholds, per the brief:
//
//   - 3 consecutive dial failures to one MX host  -> back that MX off for 30
//     minutes. Scoped to the host because one provider refusing us says nothing
//     about the others.
//   - 10 dial failures within 5 minutes across all MX hosts -> the IP itself is
//     the common factor, so cool it and route the work to Verifalia.
//
// Both count *dial* failures — timeout, refused, unreachable. An SMTP reply,
// even a rejection, means the path works and is not counted here.

import (
	"context"
	"sync"
	"time"
)

const (
	// Consecutive failed dials to one MX before backing it off.
	mxConsecutiveFailLimit = 3
	// How long that MX stays backed off.
	mxBackoffDuration = 30 * time.Minute

	// Dial failures across all MX hosts within ipFailWindow before the IP is
	// treated as the problem.
	ipFailLimit  = 10
	ipFailWindow = 5 * time.Minute

	// Simultaneous outbound port-25 connections allowed per source IP.
	maxConcurrentPerIP = 4
)

// failureTracker records dial outcomes and decides when to back off.
//
// In-memory on purpose, unlike ipstate. These are short-lived reactions to
// transport conditions measured in minutes; the persisted 24-hour cooldown in
// verifier_ip_state remains the durable decision, and this escalates into it.
type failureTracker struct {
	mu sync.Mutex

	// Consecutive failed dials per MX host, reset by any success.
	consecutive map[string]int
	// MX hosts backed off until the given time.
	backoffUntil map[string]time.Time
	// Timestamps of recent dial failures across every MX, for the IP-wide rule.
	recentFailures []time.Time

	// Counters for /metrics.
	dialAttempts  int64
	dialFailures  int64
	mxBackoffs    int64
	ipCoolTrigger int64
}

func newFailureTracker() *failureTracker {
	return &failureTracker{
		consecutive:  map[string]int{},
		backoffUntil: map[string]time.Time{},
	}
}

// backedOff reports whether this MX host is in its backoff window.
func (f *failureTracker) backedOff(mxHost string, now time.Time) (bool, time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()

	until, ok := f.backoffUntil[mxHost]
	if !ok {
		return false, time.Time{}
	}
	if now.Before(until) {
		return true, until
	}
	// Window elapsed. Clear it and give the host a clean slate, otherwise the
	// next single failure would immediately re-trip the consecutive counter.
	delete(f.backoffUntil, mxHost)
	delete(f.consecutive, mxHost)
	return false, time.Time{}
}

// dialOutcome is what the caller must do after a failed dial.
type dialOutcome struct {
	// MXBackedOff is set when this failure tripped the per-MX threshold.
	MXBackedOff bool
	// CoolIP is set when dial failures across MX hosts implicate the IP itself.
	CoolIP bool
	// Consecutive failures to this MX, after recording.
	Consecutive int
	// Failures inside the rolling window, after recording.
	InWindow int
}

// recordFailure notes one failed dial and reports whether a threshold tripped.
func (f *failureTracker) recordFailure(mxHost string, now time.Time) dialOutcome {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.dialFailures++

	f.consecutive[mxHost]++
	consecutive := f.consecutive[mxHost]

	// Drop anything that has aged out of the window before appending, so the
	// slice cannot grow without bound on a long-running process.
	cutoff := now.Add(-ipFailWindow)
	kept := f.recentFailures[:0]
	for _, t := range f.recentFailures {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	f.recentFailures = append(kept, now)

	out := dialOutcome{Consecutive: consecutive, InWindow: len(f.recentFailures)}

	if consecutive >= mxConsecutiveFailLimit {
		if _, already := f.backoffUntil[mxHost]; !already {
			f.mxBackoffs++
		}
		f.backoffUntil[mxHost] = now.Add(mxBackoffDuration)
		out.MXBackedOff = true
	}

	if len(f.recentFailures) >= ipFailLimit {
		f.ipCoolTrigger++
		out.CoolIP = true
		// Clear the window. Without this every subsequent failure would re-fire
		// the cool decision and inflate both the counter and the log.
		f.recentFailures = nil
	}

	return out
}

// recordSuccess clears the consecutive counter for one MX host.
//
// It deliberately does not touch recentFailures: the IP-wide rule is about the
// rate of failures in a window, and a success elsewhere does not undo them.
//
// It also does not increment dialAttempts — the caller already did that before
// dialling, and counting again here made every successful dial score twice, so
// the failure ratio on /metrics read better than reality.
func (f *failureTracker) recordSuccess(mxHost string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.consecutive, mxHost)
}

func (f *failureTracker) recordAttempt() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dialAttempts++
}

// Stats is a snapshot for /metrics.
type Stats struct {
	DialAttempts   int64
	DialFailures   int64
	MXBackoffs     int64
	IPCoolTriggers int64
	MXBackedOffNow int
	InFlight       int64
}

func (f *failureTracker) stats(now time.Time) Stats {
	f.mu.Lock()
	defer f.mu.Unlock()

	active := 0
	for _, until := range f.backoffUntil {
		if now.Before(until) {
			active++
		}
	}
	return Stats{
		DialAttempts:   f.dialAttempts,
		DialFailures:   f.dialFailures,
		MXBackoffs:     f.mxBackoffs,
		IPCoolTriggers: f.ipCoolTrigger,
		MXBackedOffNow: active,
	}
}

// ipSemaphore caps simultaneous outbound port-25 connections per source IP.
//
// The per-MX mutex already serialises one host, but nothing stopped the service
// opening a connection to each of twenty different MX hosts at once from the
// same address — which is the shape of traffic that looks like a spam run to a
// carrier, and the shape most likely to trip whatever is dropping our SYNs.
type ipSemaphore struct {
	mu    sync.Mutex
	slots map[string]chan struct{}

	inFlight   int64
	inFlightMu sync.Mutex
}

func newIPSemaphore() *ipSemaphore {
	return &ipSemaphore{slots: map[string]chan struct{}{}}
}

func (s *ipSemaphore) chanFor(ip string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.slots[ip]; ok {
		return ch
	}
	ch := make(chan struct{}, maxConcurrentPerIP)
	s.slots[ip] = ch
	return ch
}

// acquire blocks until a slot is free for this IP, or ctx is done.
func (s *ipSemaphore) acquire(ctx context.Context, ip string) error {
	ch := s.chanFor(ip)
	select {
	case ch <- struct{}{}:
		s.inFlightMu.Lock()
		s.inFlight++
		s.inFlightMu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *ipSemaphore) release(ip string) {
	select {
	case <-s.chanFor(ip):
		s.inFlightMu.Lock()
		s.inFlight--
		s.inFlightMu.Unlock()
	default:
	}
}

func (s *ipSemaphore) current() int64 {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	return s.inFlight
}
