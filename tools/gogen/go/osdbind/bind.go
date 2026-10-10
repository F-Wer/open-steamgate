// SPDX-License-Identifier: MIT

// Package osdbind says which address OSGo listens on, the same rule as tools/osd-bind.mjs:
//
//	-addr given             that address only (the flag wins)
//	OSD_BIND unset          loopback: 127.0.0.1, plus ::1 when the host has
//	or "localhost"          IPv6, so a client resolving localhost to ::1
//	                        still connects
//	OSD_BIND=0.0.0.0        every IPv4 interface (a container)
//	OSD_BIND=<address>      that address
//
// Loopback by default because nothing here checks a logon; a container or a
// device on a LAN says so with OSD_BIND or -addr.
package osdbind

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"syscall"
)

// Loopback addresses of the default binding.
const LoopbackV4, LoopbackV6 = "127.0.0.1", "::1"

// Selected returns the addresses to listen on, primary first; the
// primary must open, the rest are best effort (see ListenAll).
func Selected(flagValue string, explicit bool, getenv func(string) string) []string {
	if explicit && strings.TrimSpace(flagValue) != "" {
		return []string{strings.TrimSpace(flagValue)}
	}
	value := strings.TrimSpace(getenv("OSD_BIND"))
	if value == "" || strings.EqualFold(value, "localhost") {
		return []string{LoopbackV4, LoopbackV6}
	}
	return []string{value}
}

// ListenAll opens the port on every address: the first must succeed, a
// later one that the host cannot have (no IPv6) is skipped.
func ListenAll(addrs []string, port int) ([]net.Listener, error) {
	var out []net.Listener
	for i, a := range addrs {
		// osd-bind-allow: this is the module every Go listener goes through
		ln, err := net.Listen("tcp", net.JoinHostPort(a, strconv.Itoa(port)))
		if err != nil {
			if i == 0 {
				return nil, err
			}
			if !optionalBindError(err) {
				for _, l := range out {
					l.Close()
				}
				return nil, err
			}
			continue
		}
		out = append(out, ln)
		if port == 0 {
			// a random port: the twin takes the one the first got
			port = ln.Addr().(*net.TCPAddr).Port
		}
	}
	return out, nil
}

func optionalBindError(err error) bool {
	return errors.Is(err, syscall.EADDRNOTAVAIL) || errors.Is(err, syscall.EAFNOSUPPORT) ||
		errors.Is(err, syscall.EADDRINUSE)
}

// Describe lists the listeners' addresses for a log line.
func Describe(lns []net.Listener) string {
	parts := make([]string, 0, len(lns))
	for _, ln := range lns {
		parts = append(parts, ln.Addr().String())
	}
	return strings.Join(parts, ", ")
}

// Hint is the startup line for a loopback-only binding, "" otherwise.
func Hint(addrs []string) string {
	for _, a := range addrs {
		if ip := net.ParseIP(a); ip == nil || !ip.IsLoopback() {
			return ""
		}
	}
	return "listening on localhost only; for the network set OSD_BIND=0.0.0.0"
}

// ListenFlag opens a -listen style address. One that names a host is taken
// as given; a bare port (":3092" or "3092") takes the OSD_BIND addresses,
// so a default of ":port" no longer means every interface.
func ListenFlag(value string, getenv func(string) string) ([]net.Listener, error) {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, ":") {
		value = ":" + value
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return nil, err
	}
	addrs := []string{host}
	if host == "" {
		addrs = Selected("", false, getenv)
	}
	return ListenAll(addrs, port)
}
