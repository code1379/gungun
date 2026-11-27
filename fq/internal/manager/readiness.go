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

// A dedicated loopback HTTP inbound probes a direct-only route, keeping
// startup checks independent of the measured proxy node and its credentials.
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
	inbounds, ok := config["inbounds"].([]any)
	if !ok {
		_ = server.Close()
		return nil, fmt.Errorf("benchmark inbounds required")
	}
	outbounds, ok := config["outbounds"].([]any)
	if !ok {
		_ = server.Close()
		return nil, fmt.Errorf("benchmark outbounds required")
	}
	route, ok := config["route"].(map[string]any)
	if !ok {
		_ = server.Close()
		return nil, fmt.Errorf("benchmark route required")
	}
	config["inbounds"] = append(inbounds, M{"type": "http", "tag": name, "listen": "127.0.0.1", "listen_port": port})
	config["outbounds"] = append(outbounds, M{"type": "direct", "tag": name + "-direct"})
	rules := []any{M{"inbound": []string{name}, "action": "route", "outbound": name + "-direct"}}
	if original, exists := route["rules"]; exists {
		list, valid := original.([]any)
		if !valid {
			_ = server.Close()
			return nil, fmt.Errorf("invalid benchmark routing rules")
		}
		rules = append(rules, list...)
	}
	route["rules"] = rules
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
			return fmt.Errorf("sing-box routing readiness: %w", ctx.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
}
