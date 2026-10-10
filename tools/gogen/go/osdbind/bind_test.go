// SPDX-License-Identifier: MIT

package osdbind

import (
	"net"
	"strconv"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestSelectedDefaultIsLoopback(t *testing.T) {
	got := Selected("", false, env(nil))
	if len(got) != 2 || got[0] != "127.0.0.1" || got[1] != "::1" {
		t.Fatalf("default bind: %v", got)
	}
	if got := Selected("", false, env(map[string]string{"OSD_BIND": "localhost"})); got[0] != "127.0.0.1" {
		t.Fatalf("localhost: %v", got)
	}
}

func TestSelectedEnvAndFlag(t *testing.T) {
	if got := Selected("", false, env(map[string]string{"OSD_BIND": "0.0.0.0"})); len(got) != 1 || got[0] != "0.0.0.0" {
		t.Fatalf("OSD_BIND=0.0.0.0: %v", got)
	}
	if got := Selected("192.0.2.10", true, env(map[string]string{"OSD_BIND": "0.0.0.0"})); len(got) != 1 || got[0] != "192.0.2.10" {
		t.Fatalf("-addr must win over OSD_BIND: %v", got)
	}
}

func dial(t *testing.T, host string, port int) error {
	t.Helper()
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 2*time.Second)
	if err == nil {
		c.Close()
	}
	return err
}

func accept(lns []net.Listener) {
	for _, ln := range lns {
		go func(ln net.Listener) {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}(ln)
	}
}

// a non-loopback IPv4 address of this host, or "" when it has none
func outsideAddress() string {
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			return n.IP.String()
		}
	}
	return ""
}

func TestDefaultListensOnLoopbackOnly(t *testing.T) {
	lns, err := ListenAll(Selected("", false, env(nil)), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, l := range lns {
			l.Close()
		}
	}()
	accept(lns)
	port := lns[0].Addr().(*net.TCPAddr).Port
	if ip := lns[0].Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
		t.Fatalf("primary listener on %v", ip)
	}
	// a client that resolves localhost either way gets an answer
	if err := dial(t, "127.0.0.1", port); err != nil {
		t.Fatalf("127.0.0.1: %v", err)
	}
	if len(lns) > 1 {
		if err := dial(t, "::1", port); err != nil {
			t.Fatalf("::1: %v", err)
		}
	}
	if err := dial(t, "localhost", port); err != nil {
		t.Fatalf("localhost: %v", err)
	}
	if out := outsideAddress(); out != "" {
		if err := dial(t, out, port); err == nil {
			t.Fatalf("reachable on %s with the default binding", out)
		}
	}
}

func TestBindAllInterfaces(t *testing.T) {
	lns, err := ListenAll(Selected("", false, env(map[string]string{"OSD_BIND": "0.0.0.0"})), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer lns[0].Close()
	accept(lns)
	if len(lns) != 1 || !lns[0].Addr().(*net.TCPAddr).IP.IsUnspecified() {
		t.Fatalf("OSD_BIND=0.0.0.0 bound %s", Describe(lns))
	}
	port := lns[0].Addr().(*net.TCPAddr).Port
	if out := outsideAddress(); out != "" {
		if err := dial(t, out, port); err != nil {
			t.Fatalf("not reachable on %s: %v", out, err)
		}
	}
}

func TestHint(t *testing.T) {
	if Hint([]string{"127.0.0.1", "::1"}) == "" || Hint([]string{"127.0.0.1"}) == "" {
		t.Fatal("loopback binding must give the hint")
	}
	if Hint([]string{"0.0.0.0"}) != "" || Hint([]string{"192.0.2.10"}) != "" {
		t.Fatal("a network binding must not give the hint")
	}
}

func TestListenFlagBarePortTakesTheBind(t *testing.T) {
	for _, value := range []string{":0", "0"} {
		lns, err := ListenFlag(value, env(nil))
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range lns {
			if !l.Addr().(*net.TCPAddr).IP.IsLoopback() {
				t.Errorf("%q bound %s", value, Describe(lns))
			}
			l.Close()
		}
	}
	lns, err := ListenFlag(":0", env(map[string]string{"OSD_BIND": "0.0.0.0"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(lns) != 1 || !lns[0].Addr().(*net.TCPAddr).IP.IsUnspecified() {
		t.Errorf("OSD_BIND=0.0.0.0 bound %s", Describe(lns))
	}
	lns[0].Close()
	lns, err = ListenFlag("127.0.0.1:0", env(map[string]string{"OSD_BIND": "0.0.0.0"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(lns) != 1 || lns[0].Addr().(*net.TCPAddr).IP.String() != "127.0.0.1" {
		t.Errorf("a named host must be taken as given: %s", Describe(lns))
	}
	lns[0].Close()
}
