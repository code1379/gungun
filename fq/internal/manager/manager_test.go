package manager

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCorruptedBackupNeverChangesLiveConfiguration(t *testing.T) {
	m := fakeManager(t)
	if _, err := m.Apply(fixture()); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(m.Root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	id, err := m.Backup()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(m.Root, "backups", id, "state.json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = m.RestoreFiles(id); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("expected checksum rejection: %v", err)
	}
	after, _ := os.ReadFile(filepath.Join(m.Root, "state.json"))
	if string(after) != string(before) {
		t.Fatal("corrupt backup changed live state")
	}
	if err = os.Remove(filepath.Join(m.Root, "backups", id, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if err = m.RestoreFiles(id); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("expected incomplete backup rejection: %v", err)
	}
}
func fixture() State {
	return State{SchemaVersion: 1, HostID: "test-host", Kind: "public", PublicAddress: "127.0.0.1", Namespace: "a7k2p", ZoneName: "example.com", Services: []Service{}, Websites: []Website{}}
}
func service(protocol string, port int) Service {
	return Service{ID: protocol, Protocol: protocol, Port: port, PublicPort: port, EdgePort: 443, Access: "direct", Egress: "DIRECT", Domain: "node.a7k2p.example.com", Path: "/gungun"}
}
func fakeManager(t *testing.T) *Manager {
	t.Helper()
	m := New(t.TempDir(), t.TempDir())
	m.Run = func(_ context.Context, _ string, _ ...string) ([]byte, error) { return []byte("active"), nil }
	m.Verify = func(State) error { return nil }
	return m
}
func TestNormalizeCapabilities(t *testing.T) {
	for _, proto := range []string{"hysteria2", "tuic", "anytls", "snell", "vless-ws", "vless-reality"} {
		t.Run(proto, func(t *testing.T) {
			s := fixture()
			s.Services = []Service{service(proto, 20000)}
			if e := s.Normalize(); e != nil {
				t.Fatal(e)
			}
			if s.Services[0].Password == "" || s.RealityPublicKey == "" {
				t.Fatal("credentials missing")
			}
			s.Services[0].Access = "argo"
			if e := s.Normalize(); (e == nil) != (proto == "vless-ws") {
				t.Fatalf("capability: %v", e)
			}
		})
	}
}
func TestNATAndPortConflicts(t *testing.T) {
	s := fixture()
	s.Kind = "nat"
	s.Services = []Service{service("snell", 0)}
	if s.Normalize() == nil {
		t.Fatal("NAT implicit mapping accepted")
	}
	s.Kind = "public"
	s.Services = []Service{service("snell", 20000), service("anytls", 20000)}
	if s.Normalize() == nil {
		t.Fatal("duplicate port accepted")
	}
	s.Services = []Service{service("snell", 20000), service("snell", 20001)}
	if s.Normalize() == nil {
		t.Fatal("duplicate protocol accepted")
	}
}
func TestArgoExport(t *testing.T) {
	s := fixture()
	v := service("vless-ws", 20000)
	v.Access = "argo"
	s.Services = []Service{v}
	if e := s.Normalize(); e != nil {
		t.Fatal(e)
	}
	nodes := Export(s)["nodes"].([]any)
	if len(nodes) != 2 || nodes[0].(M)["port"] != 443 || nodes[1].(M)["port"] != 80 || nodes[1].(M)["tls"] != false {
		t.Fatal(nodes)
	}
	in := SingBoxConfig(s, "/etc/gungun")["inbounds"].([]any)[0].(M)
	if in["listen"] != "127.0.0.1" || in["tls"] != nil {
		t.Fatal("Argo needs public TLS listener")
	}
}
func TestApplyRollback(t *testing.T) {
	m := fakeManager(t)
	s := fixture()
	s.Services = []Service{service("snell", 20000)}
	if _, e := m.Apply(s); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(filepath.Join(m.Root, "state.json"))
	m.Verify = func(s State) error {
		if s.Services[0].Port == 20001 {
			return errors.New("health failure")
		}
		return nil
	}
	next, _ := m.Load()
	next.Services[0].Port = 20001
	if _, e := m.Apply(next); e == nil || !strings.Contains(e.Error(), "rolled back") {
		t.Fatalf("rollback: %v", e)
	}
	after, _ := os.ReadFile(filepath.Join(m.Root, "state.json"))
	if string(before) != string(after) {
		t.Fatal("old config not restored")
	}
}
func TestPrecheckIsAtomic(t *testing.T) {
	m := fakeManager(t)
	s := fixture()
	if _, e := m.Apply(s); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(filepath.Join(m.Root, "state.json"))
	m.Run = func(_ context.Context, name string, _ ...string) ([]byte, error) {
		if strings.HasSuffix(name, "sing-box") {
			return nil, errors.New("invalid config")
		}
		return nil, nil
	}
	s.Services = []Service{service("snell", 20000)}
	if _, e := m.Apply(s); e == nil {
		t.Fatal("expected failure")
	}
	after, _ := os.ReadFile(filepath.Join(m.Root, "state.json"))
	if string(before) != string(after) {
		t.Fatal("precheck changed live files")
	}
}
func TestBackupRestore(t *testing.T) {
	m := fakeManager(t)
	s := fixture()
	if _, e := m.Apply(s); e != nil {
		t.Fatal(e)
	}
	id, e := m.Backup()
	if e != nil {
		t.Fatal(e)
	}
	s.Services = []Service{service("snell", 20000)}
	if _, e = m.Apply(s); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Restore(id); e != nil {
		t.Fatal(e)
	}
	state, _ := m.Load()
	if len(state.Services) > 0 {
		t.Fatal("restore failed")
	}
	if m.RestoreFiles("../../etcZ") == nil {
		t.Fatal("path traversal accepted")
	}
}
func TestStrictJSON(t *testing.T) {
	var s State
	if Decode(strings.NewReader(`{"schemaVersion":1,"cloudflareKey":"must-not-arrive"}`), &s) == nil {
		t.Fatal("unknown CF field accepted")
	}
	if Decode(strings.NewReader(`{} {}`), &s) == nil {
		t.Fatal("trailing JSON accepted")
	}
}
func TestLock(t *testing.T) {
	m := fakeManager(t)
	unlock, e := m.Lock()
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	if second, e := m.Lock(); e == nil {
		second()
		t.Fatal("concurrent writer admitted")
	}
}
func TestCSR(t *testing.T) {
	m := fakeManager(t)
	r, e := m.CSR("a7k2p.example.com", []string{"custom.example.com"})
	if e != nil {
		t.Fatal(e)
	}
	if len(r) != 1 {
		t.Fatal("unexpected secret export")
	}
	info, _ := os.Stat(filepath.Join(m.Root, "key.pem"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("private key permissions")
	}
	block, _ := pem.Decode([]byte(r["csr"].(string)))
	csr, e := x509.ParseCertificateRequest(block.Bytes)
	if e != nil || len(csr.DNSNames) != 3 {
		t.Fatal("CSR SANs")
	}
}
func makeCertificates(t *testing.T, dir string) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost", "node.a7k2p.example.com", "*.a7k2p.example.com"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	keyDER, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	for name, block := range map[string]*pem.Block{"cert.pem": {Type: "CERTIFICATE", Bytes: der}, "key.pem": {Type: "PRIVATE KEY", Bytes: keyDER}} {
		if e = os.WriteFile(filepath.Join(dir, name), pem.EncodeToMemory(block), 0600); e != nil {
			t.Fatal(e)
		}
	}
}
func TestRealCoreSixProtocolsAndChain(t *testing.T) {
	sing, mihomo := os.Getenv("SING_BOX_BINARY"), os.Getenv("MIHOMO_BINARY")
	if sing == "" || mihomo == "" {
		t.Skip("real-core paths not supplied")
	}
	root := t.TempDir()
	makeCertificates(t, root)
	tlsTarget := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	tlsTarget.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	tlsTarget.EnableHTTP2 = true
	tlsTarget.StartTLS()
	defer tlsTarget.Close()
	s := fixture()
	for _, proto := range []string{"hysteria2", "tuic", "anytls", "snell", "vless-ws", "vless-reality"} {
		v := service(proto, 0)
		if proto == "vless-reality" {
			v.RealityServer = "localhost"
			v.RealityPort = tlsTarget.Listener.Addr().(*net.TCPAddr).Port
		}
		s.Services = append(s.Services, v)
	}
	if e := s.Normalize(); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(root, "sing-box.json")
	cfg := SingBoxConfig(s, root)
	cfg["log"] = M{"level": "debug", "timestamp": true}
	b, _ := json.Marshal(cfg)
	_ = os.WriteFile(path, b, 0600)
	if out, e := exec.Command(sing, "check", "-c", path).CombinedOutput(); e != nil {
		t.Fatalf("core config: %v: %s", e, out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log, e := os.Create(filepath.Join(root, "server.log"))
	if e != nil {
		t.Fatal(e)
	}
	defer log.Close()
	server := exec.CommandContext(ctx, sing, "run", "-c", path)
	server.Stdout = log
	server.Stderr = log
	if e = server.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cancel(); _ = server.Wait() }()
	waitForPort := func(port int) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 50*time.Millisecond)
			if err == nil {
				conn.Close()
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		logs, _ := os.ReadFile(filepath.Join(root, "server.log"))
		t.Fatalf("core listener %d not ready: %s", port, logs)
	}
	for _, item := range s.Services {
		if item.Protocol != "hysteria2" && item.Protocol != "tuic" {
			waitForPort(item.Port)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download" {
			_, _ = w.Write(make([]byte, 1000000))
		} else {
			w.WriteHeader(204)
		}
	}))
	defer target.Close()
	bin := t.TempDir()
	if e = os.Symlink(mihomo, filepath.Join(bin, "mihomo")); e != nil {
		t.Fatal(e)
	}
	m := New(root, bin)
	proxies := []M{}
	for _, v := range s.Services {
		p := M{"name": v.ID, "type": v.Protocol, "server": "127.0.0.1", "port": v.Port, "sni": "localhost", "skip-cert-verify": true, "udp": true}
		switch v.Protocol {
		case "hysteria2", "anytls":
			p["password"] = v.Password
		case "tuic":
			p["uuid"] = v.UUID
			p["password"] = v.Password
			p["congestion-controller"] = "bbr"
			p["alpn"] = []string{"h3"}
		case "snell":
			p["psk"] = v.Password
			p["version"] = 6
		case "vless-ws":
			p["type"] = "vless"
			p["uuid"] = v.UUID
			p["network"] = "ws"
			p["tls"] = true
			p["servername"] = "localhost"
			p["ws-opts"] = M{"path": v.Path, "headers": M{"Host": "localhost"}}
		case "vless-reality":
			p["type"] = "vless"
			p["uuid"] = v.UUID
			p["tls"] = true
			p["flow"] = "xtls-rprx-vision"
			p["servername"] = v.RealityServer
			p["client-fingerprint"] = "chrome"
			p["reality-opts"] = M{"public-key": s.RealityPublicKey, "short-id": s.RealityShortID}
		}
		proxies = append(proxies, p)
	}
	request := func(config M) (M, error) {
		return m.Benchmark(BenchRequest{Config: config, LatencyURL: target.URL, DownloadURL: target.URL + "/download", DownloadBytes: 1000000, TimeoutMS: 15000, Speed: true})
	}
	for _, p := range proxies {
		p := p
		t.Run(p["name"].(string), func(t *testing.T) {
			r, e := request(M{"proxies": []any{p}, "mode": "rule", "rules": []string{"MATCH," + p["name"].(string)}, "log-level": "warning"})
			if e != nil {
				logs, _ := os.ReadFile(filepath.Join(root, "server.log"))
				t.Fatalf("real request: %v\n%s", e, logs)
			}
			if r["speedMBps"] == nil {
				t.Fatal("no real download")
			}
		})
	}
	for _, entry := range proxies {
		for _, final := range proxies {
			if final["name"] == "hysteria2" || final["name"] == "tuic" {
				continue
			}
			t.Run("chain-matrix/"+entry["name"].(string)+"-to-"+final["name"].(string), func(t *testing.T) {
				exit := M{}
				for key, value := range final {
					exit[key] = value
				}
				exit["name"] = "matrix-exit"
				exit["dialer-proxy"] = entry["name"]
				result, err := request(M{"proxies": []any{entry, exit}, "mode": "rule", "rules": []string{"MATCH,matrix-exit"}, "log-level": "debug"})
				if err != nil {
					logs, _ := os.ReadFile(filepath.Join(root, "server.log"))
					if len(logs) > 16000 {
						logs = logs[len(logs)-16000:]
					}
					t.Fatalf("actual protocol-chain compatibility: %v\nserver log: %s", err, logs)
				}
				if result["speedMBps"] == nil {
					t.Fatal("chain matrix did not download real data")
				}
			})
		}
	}
	second := fixture()
	second.Services = []Service{service("snell", 0)}
	if e = second.Normalize(); e != nil {
		t.Fatal(e)
	}
	v := second.Services[0]
	b, _ = json.Marshal(SingBoxConfig(second, root))
	path2 := filepath.Join(root, "second.json")
	_ = os.WriteFile(path2, b, 0600)
	server2 := exec.CommandContext(ctx, sing, "run", "-c", path2)
	server2.Stdout = log
	server2.Stderr = log
	if e = server2.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { _ = server2.Process.Kill(); _ = server2.Wait() }()
	waitForPort(v.Port)
	var first M
	for _, p := range proxies {
		if p["name"] == "snell" {
			first = p
		}
	}
	exit := M{"name": "exit", "type": "snell", "server": "127.0.0.1", "port": v.Port, "psk": v.Password, "version": 6, "dialer-proxy": "snell"}
	if _, e = request(M{"proxies": []any{first, exit}, "mode": "rule", "rules": []string{"MATCH,exit"}}); e != nil {
		t.Fatalf("real two-hop dialer-proxy: %v", e)
	}
}

func TestTunnelExplicitDisable(t *testing.T) {
	m := fakeManager(t)
	s := fixture()
	s.TunnelToken = "scoped-test-token"
	if _, e := m.Apply(s); e != nil {
		t.Fatal(e)
	}
	redacted, e := m.PublicState()
	if e != nil {
		t.Fatal(e)
	}
	if redacted.TunnelToken != "" {
		t.Fatal("token leaked")
	}
	if _, e = m.Apply(redacted); e != nil {
		t.Fatal(e)
	}
	stored, _ := m.Load()
	if stored.TunnelToken == "" {
		t.Fatal("redacted state erased token")
	}
	redacted.DisableTunnel = true
	if _, e = m.Apply(redacted); e != nil {
		t.Fatal(e)
	}
	stored, _ = m.Load()
	if stored.TunnelToken != "" {
		t.Fatal("explicit disable failed")
	}
	if _, e = os.Stat(filepath.Join(m.Root, "tunnel.enabled")); !os.IsNotExist(e) {
		t.Fatal("disabled tunnel still enabled at boot")
	}
}

func TestWebsiteListenerTransportCompatibility(t *testing.T) {
	for _, item := range []struct {
		first, second string
		valid         bool
	}{{"direct", "cdn", true}, {"argo", "argo", true}, {"direct", "argo", false}, {"argo", "cdn", false}} {
		t.Run(item.first+"-"+item.second, func(t *testing.T) {
			s := fixture()
			s.Websites = []Website{
				{ID: "first", Domain: "one.example.com", Target: "127.0.0.1", TargetPort: 3000, Access: item.first, Port: 38443, PublicPort: 38443, EdgePort: 443},
				{ID: "second", Domain: "two.example.com", Target: "127.0.0.1", TargetPort: 8080, Access: item.second, Port: 38443, PublicPort: 38443, EdgePort: 443},
			}
			err := s.Normalize()
			if (err == nil) != item.valid {
				t.Fatalf("transport validation: %v", err)
			}
		})
	}
}
