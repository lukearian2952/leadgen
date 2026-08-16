package prober

// Transport diagnostics.
//
// This exists because a shell probe from the host and a dial from inside this
// process are not the same measurement, and the difference is exactly where the
// port-25 investigation kept going wrong. `nc` resolves with libc, picks its own
// address family, and binds whatever source address the kernel chooses. The
// prober resolves with Go's resolver, pins the family to the bound IP, and binds
// LocalAddr explicitly. A diagnosis taken from the first and applied to the
// second is an assumption, not a measurement.
//
// So this reports what the prober itself experiences, per attempt: every
// address the host resolved to, which family each is, which one was dialled,
// whether it connected, and how long it took.

import (
	"context"
	"fmt"
	"net"
	"time"
)

// DialAttempt is one dial to one resolved address.
type DialAttempt struct {
	Target   string `json:"target"`
	IP       string `json:"ip"`
	Family   string `json:"family"` // ipv4 | ipv6
	Network  string `json:"network"`
	LocalIP  string `json:"local_ip"`
	OK       bool   `json:"ok"`
	Err      string `json:"err,omitempty"`
	Banner   string `json:"banner,omitempty"`
	ElapsedM int64  `json:"elapsed_ms"`
}

// DialReport is the result of probing one host.
type DialReport struct {
	Host      string        `json:"host"`
	Port      string        `json:"port"`
	ResolvedV4 []string     `json:"resolved_v4"`
	ResolvedV6 []string     `json:"resolved_v6"`
	ResolveErr string       `json:"resolve_err,omitempty"`
	Attempts  []DialAttempt `json:"attempts"`
	OKCount   int           `json:"ok_count"`
	Total     int           `json:"total"`
}

// DebugDial resolves a host and dials every resolved address individually, on
// the family that address requires.
//
// Dialling each address separately rather than by hostname is deliberate: a
// hostname dial hides which address answered, and "aspmx.l.google.com is
// reachable" is a different claim from "every A record for it is reachable".
// The failures being investigated differ between those two, so the report has
// to distinguish them.
//
// readBanner controls whether it waits for the SMTP greeting. A TCP connect
// that succeeds but never produces a banner is a different failure from a
// connect that never completes, and only the banner read tells them apart.
func (p *Prober) DebugDial(
	ctx context.Context, host, port string, families []string, readBanner bool,
) DialReport {
	report := DialReport{Host: host, Port: port}

	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		report.ResolveErr = err.Error()
		return report
	}

	var targets []net.IPAddr
	for _, a := range addrs {
		fam := "ipv6"
		if a.IP.To4() != nil {
			fam = "ipv4"
		}
		if fam == "ipv4" {
			report.ResolvedV4 = append(report.ResolvedV4, a.IP.String())
		} else {
			report.ResolvedV6 = append(report.ResolvedV6, a.IP.String())
		}
		if wanted(families, fam) {
			targets = append(targets, a)
		}
	}

	for _, a := range targets {
		report.Attempts = append(report.Attempts, p.debugOne(ctx, host, port, a, readBanner))
	}

	report.Total = len(report.Attempts)
	for _, at := range report.Attempts {
		if at.OK {
			report.OKCount++
		}
	}
	return report
}

func (p *Prober) debugOne(
	ctx context.Context, host, port string, addr net.IPAddr, readBanner bool,
) DialAttempt {
	family, network := "ipv6", "tcp6"
	if addr.IP.To4() != nil {
		family, network = "ipv4", "tcp4"
	}

	at := DialAttempt{
		Target:  host,
		IP:      addr.IP.String(),
		Family:  family,
		Network: network,
	}

	// Bind the same local address the prober would, but only when the family
	// matches — binding an IPv4 LocalAddr to a tcp6 dial fails for reasons that
	// have nothing to do with the network being measured.
	dialer := &net.Dialer{Timeout: dialTimeout}
	for _, configured := range p.cfg.IPs {
		local := net.ParseIP(configured)
		if local == nil {
			continue
		}
		if (local.To4() != nil) == (addr.IP.To4() != nil) {
			dialer.LocalAddr = &net.TCPAddr{IP: local}
			at.LocalIP = configured
			break
		}
	}

	started := time.Now()
	conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
	if err != nil {
		at.ElapsedM = time.Since(started).Milliseconds()
		at.Err = err.Error()
		return at
	}
	defer conn.Close()

	at.OK = true

	if readBanner {
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		buf := make([]byte, 256)
		n, rerr := conn.Read(buf)
		if rerr != nil {
			at.Err = "connected but no banner: " + rerr.Error()
		} else {
			at.Banner = string(buf[:n])
		}
	}

	at.ElapsedM = time.Since(started).Milliseconds()
	return at
}

func wanted(families []string, fam string) bool {
	if len(families) == 0 {
		return true
	}
	for _, f := range families {
		if f == fam {
			return true
		}
	}
	return false
}

// DebugSweep runs DebugDial n times against one host, pausing gapMS between
// rounds, and returns every round.
//
// The single-shot version cannot see the failure this is meant to characterise:
// the first few connections succeed and everything after them times out, so any
// one-shot probe reports whichever side of that cliff it happened to land on.
func (p *Prober) DebugSweep(
	ctx context.Context, host, port string, families []string, n, gapMS int, readBanner bool,
) []DialReport {
	out := make([]DialReport, 0, n)
	for i := 0; i < n; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return out
			case <-time.After(time.Duration(gapMS) * time.Millisecond):
			}
		}
		out = append(out, p.DebugDial(ctx, host, port, families, readBanner))
	}
	return out
}

// String renders one attempt for the log.
func (a DialAttempt) String() string {
	status := "OK"
	if !a.OK {
		status = "FAIL"
	}
	return fmt.Sprintf("%s %s(%s) via %s from %s -> %s %dms %s",
		a.Target, a.IP, a.Family, a.Network, a.LocalIP, status, a.ElapsedM, a.Err)
}
