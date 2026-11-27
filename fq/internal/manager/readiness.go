package manager

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// A listening proxy socket precedes Mihomo's Running state. A separate named
// inbound and DIRECT-only rule probe readiness without contacting the test node.
type coreReadiness struct {
	server    *http.Server
	target    string
	marker    string
	proxyPort int
}

func newCoreReadiness(config map[string]any) (*coreReadiness, error) {
	marker := "gungun-ready-" + RandomSecret()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Connection", "close")
		_, _ = io.WriteString(w, marker)
	}), ReadHeaderTimeout: time.Second}
	go func() { _ = server.Serve(listener) }()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		return nil, err
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	name := "gungun-readiness"
	config["listeners"] = []any{M{"name": name, "type": "http", "listen": "127.0.0.1", "port": port}}
	rules := []string{"IN-NAME," + name + ",DIRECT"}
	switch original := config["rules"].(type) {
	case []string:
		rules = append(rules, original...)
	case []any:
		for _, rule := range original {
			text, ok := rule.(string)
			if !ok {
				_ = server.Close()
				return nil, fmt.Errorf("invalid benchmark rule")
			}
			rules = append(rules, text)
		}
	default:
		_ = server.Close()
		return nil, fmt.Errorf("benchmark rules required")
	}
	config["rules"] = rules
	return &coreReadiness{server: server, target: "http://" + listener.Addr().String() + "/", marker: marker, proxyPort: port}, nil
}
func (r *coreReadiness) Close() { _ = r.server.Close() }
func (r *coreReadiness) Wait(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	proxy, _ := url.Parse("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(r.proxyPort)))
	transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 250 * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	for {
		request, _ := http.NewRequestWithContext(ctx, "GET", r.target, nil)
		response, err := client.Do(request)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(response.Body, 1024))
			_ = response.Body.Close()
			if readErr == nil && response.StatusCode == http.StatusOK && string(body) == r.marker {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Mihomo routing readiness: %w", ctx.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
}
