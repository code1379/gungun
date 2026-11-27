package manager

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type BenchRequest struct {
	Config         map[string]any `json:"config"`
	LatencyURL     string         `json:"latencyUrl"`
	DownloadURL    string         `json:"downloadUrl"`
	DownloadBytes  int64          `json:"downloadBytes"`
	TimeoutMS      int            `json:"timeoutMs"`
	SpeedTimeoutMS int            `json:"speedTimeoutMs"`
	Speed          bool           `json:"speed"`
}

type speedTracker struct {
	started     time.Time
	windowStart time.Time
	totalBytes  int64
	windowBytes int64
	peakMBps    float64
}

func newSpeedTracker(now time.Time) *speedTracker {
	return &speedTracker{started: now, windowStart: now}
}

func (s *speedTracker) add(bytes int64, now time.Time) {
	if bytes <= 0 {
		return
	}
	s.totalBytes += bytes
	s.windowBytes += bytes
	elapsed := now.Sub(s.windowStart)
	if elapsed >= time.Second {
		sample := float64(s.windowBytes) / elapsed.Seconds() / 1_000_000
		if sample > s.peakMBps {
			s.peakMBps = sample
		}
		s.windowBytes = 0
		s.windowStart = now
	}
}

func (s *speedTracker) finish(now time.Time) (averageMBps, peakMBps float64) {
	elapsed := now.Sub(s.started).Seconds()
	if elapsed <= 0 || s.totalBytes <= 0 {
		return 0, 0
	}
	averageMBps = float64(s.totalBytes) / elapsed / 1_000_000
	finalWindow := now.Sub(s.windowStart).Seconds()
	if s.windowBytes > 0 && finalWindow > 0 && (finalWindow >= 0.5 || s.peakMBps == 0) {
		sample := float64(s.windowBytes) / finalWindow / 1_000_000
		if sample > s.peakMBps {
			s.peakMBps = sample
		}
	}
	peakMBps = s.peakMBps
	if peakMBps == 0 {
		peakMBps = averageMBps
	}
	return averageMBps, peakMBps
}

type speedTrackingWriter struct {
	tracker *speedTracker
}

func (w speedTrackingWriter) Write(data []byte) (int, error) {
	w.tracker.add(int64(len(data)), time.Now())
	return len(data), nil
}

type limitedLog struct {
	mu   sync.Mutex
	data string
}

func (l *limitedLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.data += string(b)
	if len(l.data) > 12000 {
		l.data = l.data[len(l.data)-12000:]
	}
	return len(b), nil
}
func (l *limitedLog) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.data }

func (m *Manager) Benchmark(r BenchRequest) (measurement M, runErr error) {
	if r.TimeoutMS < 3000 || r.TimeoutMS > 120000 || r.DownloadBytes < 100000 || r.DownloadBytes > 100000000 {
		return nil, fmt.Errorf("invalid benchmark limits")
	}
	for _, raw := range []string{r.LatencyURL, r.DownloadURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
			return nil, fmt.Errorf("invalid test URL")
		}
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return nil, e
	}
	port := listener.Addr().(*net.TCPAddr).Port
	defer listener.Close()
	r.Config["inbounds"] = []any{M{"type": "mixed", "tag": "gungun-benchmark", "listen": "127.0.0.1", "listen_port": port}}
	readiness, e := newCoreReadiness(r.Config)
	if e != nil {
		return nil, e
	}
	defer readiness.Close()
	dir, e := os.MkdirTemp("", "fq-bench-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(dir)
	b, e := json.Marshal(r.Config)
	if e != nil {
		return nil, e
	}
	path := filepath.Join(dir, "config.json")
	if e = os.WriteFile(path, b, 0600); e != nil {
		return nil, e
	}
	speedTimeout := r.SpeedTimeoutMS
	if speedTimeout < 10000 || speedTimeout > 300000 {
		speedTimeout = 120000
	}
	totalTimeout := r.TimeoutMS*2 + 10000
	if r.Speed {
		totalTimeout += speedTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(totalTimeout)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(m.Bin, "sing-box"), "run", "--disable-color", "-D", dir, "-c", path)
	coreLog := &limitedLog{}
	cmd.Stdout = coreLog
	cmd.Stderr = coreLog
	_ = listener.Close()
	if e = cmd.Start(); e != nil {
		return nil, e
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if runErr != nil && coreLog.String() != "" {
			runErr = fmt.Errorf("%w; core log: %s", runErr, coreLog.String())
		}
	}()
	endpoint := fmt.Sprintf("127.0.0.1:%d", port)
	if e = readiness.Wait(ctx); e != nil {
		return nil, e
	}
	proxy, _ := url.Parse("socks5://" + endpoint)
	transport := &http.Transport{
		Proxy:             http.ProxyURL(proxy),
		ForceAttemptHTTP2: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Duration(r.TimeoutMS) * time.Millisecond, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return fmt.Errorf("redirect limit")
		}
		return nil
	}}
	// Match v2rayN: warm the connection with two sequential requests, separated
	// by 100 ms, and report the faster successful response.
	latencySamples := make([]float64, 0, 2)
	for attempt := 0; attempt < 2; attempt++ {
		start := time.Now()
		res, requestErr := client.Get(r.LatencyURL)
		if requestErr != nil {
			return nil, requestErr
		}
		if res.StatusCode < 200 || res.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
			res.Body.Close()
			return nil, fmt.Errorf("latency HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
		}
		_, requestErr = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		if requestErr != nil {
			return nil, requestErr
		}
		latencySamples = append(latencySamples, float64(time.Since(start).Microseconds())/1000)
		if attempt == 0 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	latencyMs := latencySamples[0]
	if latencySamples[1] < latencyMs {
		latencyMs = latencySamples[1]
	}
	result := M{
		"latencyMs": latencyMs,
		"speedMBps": nil,
		"speedAvgMBps": nil,
		"speedPeakMBps": nil,
		"error": nil,
	}
	if r.Speed {
		downloadClient := &http.Client{
			Transport: transport,
			Timeout: time.Duration(speedTimeout) * time.Millisecond,
			CheckRedirect: client.CheckRedirect,
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, r.DownloadURL, nil)
		if requestErr != nil {
			return nil, requestErr
		}
		request.Header.Set("Range", fmt.Sprintf("bytes=0-%d", r.DownloadBytes-1))
		tracker := newSpeedTracker(time.Now())
		res, requestErr := downloadClient.Do(request)
		if requestErr != nil {
			return nil, requestErr
		}
		if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusPartialContent {
			res.Body.Close()
			return nil, fmt.Errorf("download HTTP %d", res.StatusCode)
		}
		count, copyErr := io.Copy(speedTrackingWriter{tracker: tracker}, io.LimitReader(res.Body, r.DownloadBytes))
		res.Body.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if count < 100000 {
			return nil, fmt.Errorf("download too small: %d", count)
		}
		average, peak := tracker.finish(time.Now())
		result["speedMBps"] = average
		result["speedAvgMBps"] = average
		result["speedPeakMBps"] = peak
	}
	return result, nil
}
func (m *Manager) Warp(action string) (M, error) {
	if action == "install" {
		if _, e := exec.LookPath("apt-get"); e != nil {
			return nil, fmt.Errorf("WARP auto-install requires Debian/Ubuntu apt")
		}
		script := `set -eu
. /etc/os-release
case "$VERSION_CODENAME" in bookworm|trixie|bullseye|jammy|noble) ;; *) echo 'Unsupported WARP apt distribution' >&2; exit 1;; esac
apt-get update
apt-get install -y curl gnupg ca-certificates
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
printf 'deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ %s main\n' "$VERSION_CODENAME" > /etc/apt/sources.list.d/cloudflare-client.list
apt-get update
apt-get install -y cloudflare-warp
`
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, e := m.Run(ctx, "sh", "-c", script); e != nil {
			return nil, e
		}
		if _, e := m.Command("warp-cli", "--accept-tos", "registration", "show"); e != nil {
			if _, e = m.Command("warp-cli", "--accept-tos", "registration", "new"); e != nil {
				return nil, e
			}
		}
		for _, args := range [][]string{{"mode", "proxy"}, {"proxy", "port", "40000"}, {"connect"}} {
			if _, e := m.Command("warp-cli", append([]string{"--accept-tos"}, args...)...); e != nil {
				return nil, e
			}
		}
	} else if action == "connect" || action == "disconnect" {
		if _, e := m.Command("warp-cli", "--accept-tos", action); e != nil {
			return nil, e
		}
	} else if action != "status" {
		return nil, fmt.Errorf("invalid WARP action")
	}
	out, e := m.Command("warp-cli", "--accept-tos", "status")
	return M{"status": strings.TrimSpace(string(out))}, e
}
