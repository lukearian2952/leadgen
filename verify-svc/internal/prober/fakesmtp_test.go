package prober

// A minimal SMTP server, enough for the prober to talk to.
//
// The alternative is probing a real mailbox provider from a test, which is
// neither repeatable nor polite, and which cannot be made to produce a
// catch-all or a specific 5xx on demand. This records every RCPT it receives,
// which is what makes "exactly one RCPT" an assertion rather than a claim.

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
)

type fakeSMTP struct {
	t        *testing.T
	listener net.Listener

	mu sync.Mutex
	// Every RCPT TO address received, in order, across all connections.
	rcpts []string
	// Number of connections accepted.
	connections int

	// reply decides the response to a RCPT. Defaults to 550.
	reply func(addr string) string
}

func newFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeSMTP{t: t, listener: ln}
	f.reply = func(string) string { return "550 5.1.1 no such user" }

	go f.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return f
}

func (f *fakeSMTP) addr() (host, port string) {
	h, p, _ := net.SplitHostPort(f.listener.Addr().String())
	return h, p
}

func (f *fakeSMTP) serve() {
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.connections++
		f.mu.Unlock()
		go f.handle(conn)
	}
}

func (f *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()

	r := bufio.NewReader(conn)
	fmt.Fprintf(conn, "220 fake.test ESMTP\r\n")

	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))

		switch {
		case strings.HasPrefix(cmd, "EHLO"):
			// No extensions advertised: net/smtp would try STARTTLS if offered,
			// and a plaintext fake has nothing to upgrade to.
			fmt.Fprintf(conn, "250-fake.test\r\n250 SIZE 10240000\r\n")
		case strings.HasPrefix(cmd, "HELO"):
			fmt.Fprintf(conn, "250 fake.test\r\n")
		case strings.HasPrefix(cmd, "MAIL FROM"):
			fmt.Fprintf(conn, "250 2.1.0 ok\r\n")
		case strings.HasPrefix(cmd, "RCPT TO"):
			addr := extractAddr(line)
			f.mu.Lock()
			f.rcpts = append(f.rcpts, addr)
			f.mu.Unlock()
			fmt.Fprintf(conn, "%s\r\n", f.reply(addr))
		case strings.HasPrefix(cmd, "QUIT"):
			fmt.Fprintf(conn, "221 2.0.0 bye\r\n")
			return
		case strings.HasPrefix(cmd, "RSET"):
			fmt.Fprintf(conn, "250 2.0.0 ok\r\n")
		default:
			fmt.Fprintf(conn, "500 5.5.1 unrecognised\r\n")
		}
	}
}

func extractAddr(line string) string {
	start := strings.Index(line, "<")
	end := strings.LastIndex(line, ">")
	if start >= 0 && end > start {
		return strings.ToLower(line[start+1 : end])
	}
	return strings.ToLower(strings.TrimSpace(line))
}

func (f *fakeSMTP) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.rcpts...)
}

// realRCPTs is every recorded RCPT except the random catch-all probe, which the
// prober always sends first and which is not a candidate address.
func (f *fakeSMTP) realRCPTs() []string {
	var out []string
	for _, a := range f.recorded() {
		if !strings.HasPrefix(a, "zz") {
			out = append(out, a)
		}
	}
	return out
}

func (f *fakeSMTP) connCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connections
}
