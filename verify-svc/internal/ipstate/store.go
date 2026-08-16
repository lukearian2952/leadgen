// Package ipstate is the persisted health of our outbound verification IPs.
//
// It has to be persisted, not in-memory, for two reasons: a container restart
// must not un-cool an IP that a mailbox provider has blocked, and if we ever
// run more than one verify-svc they must agree about which IPs are burnt.
//
// The table (`verifier_ip_state`) is created by the Supabase migration, not by
// this service — the schema has one owner.
package ipstate

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CooldownDuration is how long a blocked IP stays out of rotation.
//
// A block from a large provider lasts hours, and retrying through it deepens
// the block rather than clearing it. Twenty-four hours is the brief's number
// and it is deliberately generous: the cost of waiting is a slower campaign,
// the cost of not waiting is a permanently listed IP.
const CooldownDuration = 24 * time.Hour

// Hourly per-IP ceilings.
const (
	HourlyCapStrict  = 150 // Gmail, Microsoft
	HourlyCapDefault = 400 // everyone else
)

// strictMX matches the mailbox providers that police connection rates hardest.
// Anchored on a label boundary so `mx.google.com.evil.example` does not match.
var strictMX = regexp.MustCompile(
	`(^|\.)(google\.com|googlemail\.com|gmail\.com|outlook\.com|hotmail\.com|` +
		`protection\.outlook\.com|microsoft\.com|office365\.com)\.?$`)

// HourlyCap returns the per-IP hourly ceiling for a given MX host.
func HourlyCap(mxHost string) int {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(mxHost), "."))
	if strictMX.MatchString(host) {
		return HourlyCapStrict
	}
	return HourlyCapDefault
}

// blockCode matches responses that mean "this IP is refused", as distinct from
// "this mailbox does not exist".
//
// The distinction is the entire point of the cooldown. A 550 on RCPT is a
// verification *result*. A 421/450/451, or any 4.7.x / 5.7.1, is about us.
// Conflating the two would cool every IP the first time it found a bad address.
var (
	blockCode = regexp.MustCompile(`\b(421|450|451)\b|\b4\.7\.\d+\b|\b5\.7\.1\b`)
	blockText = regexp.MustCompile(`(?i)\b(blocked|blacklist(ed)?|spamhaus|barracuda|banned|` +
		`denied due to|reputation|too many connections|rate limited)\b`)
)

// IsBlockResponse reports whether an SMTP reply means the IP itself is refused.
func IsBlockResponse(response string) bool {
	if response == "" {
		return false
	}
	return blockCode.MatchString(response) || blockText.MatchString(response)
}

// Record is one outbound IP's current health.
type Record struct {
	IP           string
	State        string // active | cooling | disabled
	CoolingUntil *time.Time
	ChecksHour   int
	HourWindow   time.Time
	BlocksSeen   int
	LastReason   string
}

// coolingNow reports whether this IP is currently out of rotation.
func (r Record) coolingNow(now time.Time) bool {
	if r.State == "disabled" {
		return true
	}
	return r.State == "cooling" && r.CoolingUntil != nil && now.Before(*r.CoolingUntil)
}

// hasHeadroom reports whether the hourly counter still allows a check.
func (r Record) hasHeadroom(mxHost string, now time.Time) bool {
	if !sameHour(r.HourWindow, now) {
		return true // the counter resets in this new hour
	}
	return r.ChecksHour < HourlyCap(mxHost)
}

func sameHour(a, b time.Time) bool {
	return a.UTC().Truncate(time.Hour).Equal(b.UTC().Truncate(time.Hour))
}

// Store owns reads and writes of verifier_ip_state, plus the rotation cursor.
type Store struct {
	pool *pgxpool.Pool

	mu     sync.Mutex
	cursor int
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Ensure inserts any configured IP that is not yet tracked. Called at boot so
// the table always reflects VERIFY_IPS.
func (s *Store) Ensure(ctx context.Context, ips []string) error {
	for _, ip := range ips {
		_, err := s.pool.Exec(ctx,
			`insert into verifier_ip_state (ip, state, checks_hour_window)
			 values ($1::inet, 'active', date_trunc('hour', now()))
			 on conflict (ip) do nothing`,
			ip)
		if err != nil {
			return fmt.Errorf("ensure ip %s: %w", ip, err)
		}
	}
	return nil
}

// Load reads the current state of every configured IP, in the configured order.
func (s *Store) Load(ctx context.Context, ips []string) ([]Record, error) {
	if len(ips) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx,
		`select host(ip), state, cooling_until, checks_hour, checks_hour_window,
		        blocks_seen, last_reason
		   from verifier_ip_state
		  where host(ip) = any($1::text[])`,
		ips)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byIP := map[string]Record{}
	for rows.Next() {
		var r Record
		if err := rows.Scan(&r.IP, &r.State, &r.CoolingUntil, &r.ChecksHour,
			&r.HourWindow, &r.BlocksSeen, &r.LastReason); err != nil {
			return nil, err
		}
		byIP[r.IP] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Preserve the VERIFY_IPS ordering so rotation is predictable.
	out := make([]Record, 0, len(ips))
	for _, ip := range ips {
		if r, ok := byIP[ip]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// Decision is the outcome of picking an IP.
type Decision struct {
	IP         string
	AllCooling bool // every IP is blocked — caller should fall back to Verifalia
	AllAtCap   bool // healthy but hourly-exhausted — waiting fixes this
}

// Choose picks the next usable IP, round-robin.
func (s *Store) Choose(ctx context.Context, ips []string, mxHost string) (Decision, error) {
	records, err := s.Load(ctx, ips)
	if err != nil {
		return Decision{}, err
	}
	if len(records) == 0 {
		return Decision{}, nil
	}

	now := time.Now()

	var notCooling []Record
	for _, r := range records {
		if !r.coolingNow(now) {
			notCooling = append(notCooling, r)
		}
	}
	if len(notCooling) == 0 {
		return Decision{AllCooling: true}, nil
	}

	var usable []Record
	for _, r := range notCooling {
		if r.hasHeadroom(mxHost, now) {
			usable = append(usable, r)
		}
	}
	if len(usable) == 0 {
		return Decision{AllAtCap: true}, nil
	}

	s.mu.Lock()
	idx := s.cursor % len(usable)
	s.cursor++
	s.mu.Unlock()

	return Decision{IP: usable[idx].IP}, nil
}

// RecordCheck increments the hourly counter, rolling the window if needed.
func (s *Store) RecordCheck(ctx context.Context, ip string) error {
	_, err := s.pool.Exec(ctx,
		`update verifier_ip_state
		    set checks_hour = case
		          when checks_hour_window < date_trunc('hour', now()) then 1
		          else checks_hour + 1 end,
		        checks_hour_window = date_trunc('hour', now()),
		        state = case
		          when state = 'cooling' and cooling_until is not null and cooling_until <= now()
		          then 'active' else state end,
		        cooling_until = case
		          when state = 'cooling' and cooling_until is not null and cooling_until <= now()
		          then null else cooling_until end,
		        updated_at = now()
		  where host(ip) = $1`, ip)
	return err
}

// Cool takes an IP out of rotation for CooldownDuration.
func (s *Store) Cool(ctx context.Context, ip, reason string) error {
	if len(reason) > 500 {
		reason = reason[:500]
	}
	_, err := s.pool.Exec(ctx,
		`update verifier_ip_state
		    set state = 'cooling',
		        cooling_until = now() + $2::interval,
		        blocks_seen = blocks_seen + 1,
		        last_reason = $3,
		        updated_at = now()
		  where host(ip) = $1`,
		ip, CooldownDuration.String(), reason)
	return err
}

// ActiveCount is how many IPs are currently usable at all, for /healthz.
func (s *Store) ActiveCount(ctx context.Context, ips []string) (int, error) {
	records, err := s.Load(ctx, ips)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	count := 0
	for _, r := range records {
		if !r.coolingNow(now) {
			count++
		}
	}
	return count, nil
}
