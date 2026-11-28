package manager

import (
	"context"
	"fmt"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
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
	"sync/atomic"
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
	m.InitSystem = "systemd"
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
		t.Fatal("duplicate TCP port accepted")
	}
	s.Services = []Service{service("hysteria2", 20000), service("vless-ws", 20000)}
	if err := s.Normalize(); err != nil {
		t.Fatalf("same numeric port should be allowed for UDP and TCP: %v", err)
	}
	s.Services = []Service{service("hysteria2", 20000), service("tuic", 20000)}
	if s.Normalize() == nil {
		t.Fatal("duplicate UDP port accepted")
	}
	s.Services = []Service{service("snell", 20000), service("snell", 20001)}
	if s.Normalize() == nil {
		t.Fatal("duplicate protocol accepted")
	}
}
func TestVlessWSAccessModesShareOneInbound(t *testing.T) {
	s := fixture()
	direct := service("vless-ws", 45516)
	direct.PublicPort = 45516
	cdn := direct
	cdn.ID = "vless-ws-cdn"
	cdn.Access = "cdn"
	cdn.Domain = "cdn.example.com"
	cdn.PublicPort = 45516
	cdn.EdgeScheme = "http"
	cdn.EdgePort = 80
	argo := direct
	argo.ID = "vless-ws-argo"
	argo.Access = "argo"
	argo.Domain = "argo.example.com"
	argo.PublicPort = 0
	s.Services = []Service{direct, cdn, argo}
	if err := s.Normalize(); err != nil { t.Fatal(err) }
	inbounds := SingBoxConfig(s, "/etc/gungun")["inbounds"].([]any)
	count := 0
	for _, value := range inbounds {
		in := value.(M)
		if in["type"] == "vless" {
			count++
			if in["listen"] != "127.0.0.1" || in["listen_port"] != s.Services[0].BackendPort || in["tls"] != nil {
				t.Fatalf("unexpected loopback VLESS inbound: %#v", in)
			}
		}
	}
	if count != 1 { t.Fatalf("VLESS inbound count = %d, want 1", count) }
	if s.Services[0].UUID == "" || s.Services[0].UUID != s.Services[1].UUID || s.Services[1].UUID != s.Services[2].UUID {
		t.Fatal("VLESS WS access modes must share one generated UUID")
	}
	if s.Services[0].BackendPort == 0 || s.Services[0].BackendPort != s.Services[1].BackendPort || s.Services[1].BackendPort != s.Services[2].BackendPort {
		t.Fatal("VLESS WS access modes must share one backend port")
	}
	s.Services[1].PublicPort = 18880
	if err := s.Normalize(); err == nil { t.Fatal("VLESS WS CDN and direct must share one public mapping") }
	nodes := Export(s)["nodes"].([]any)
	var cdnNode M
	for _, value := range nodes { node := value.(M); if node["access"] == "cdn" { cdnNode = node } }
	if cdnNode["port"] != 80 || cdnNode["tls"] != false { t.Fatalf("HTTP CDN export = %#v", cdnNode) }
}

func TestVlessWSEdgeSchemeDefaultsAndPorts(t *testing.T) {
	http := fixture()
	v := service("vless-ws", 45516)
	v.Access = "cdn"
	v.Domain = "cdn.example.com"
	v.EdgeScheme = "http"
	v.EdgePort = 0
	http.Services = []Service{v}
	if err := http.Normalize(); err != nil { t.Fatal(err) }
	if http.Services[0].EdgePort != 80 { t.Fatalf("HTTP default Edge port = %d, want 80", http.Services[0].EdgePort) }

	https := fixture()
	v = service("vless-ws", 45516)
	v.Access = "cdn"
	v.Domain = "cdn.example.com"
	v.EdgeScheme = "https"
	v.EdgePort = 2053
	https.Services = []Service{v}
	if err := https.Normalize(); err != nil { t.Fatal(err) }

	invalid := fixture()
	v.EdgeScheme = "http"
	v.EdgePort = 443
	invalid.Services = []Service{v}
	if err := invalid.Normalize(); err == nil { t.Fatal("HTTPS port must not be accepted for HTTP Edge scheme") }
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
	if in["listen"] != "127.0.0.1" || in["tls"] != nil || in["listen_port"] != s.Services[0].BackendPort {
		t.Fatal("Argo VLESS must use the shared loopback HTTP backend behind Caddy")
	}
	caddy := CaddyConfig(s, "/etc/gungun")
	server := caddy["apps"].(M)["http"].(M)["servers"].(M)["port_20000"].(M)
	if server["listen"].([]string)[0] != "127.0.0.1:20000" {
		t.Fatal("Argo-only Caddy listener must bind to loopback")
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
	r, e := m.CSR("a7k2p.example.com", []string{
		"node.a7k2p.example.com",
		"a7k2p.example.com",
		"*.a7k2p.example.com",
		"custom.example.com",
		"custom.example.com",
		"deep.node.a7k2p.example.com",
	})
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
	if e != nil {
		t.Fatalf("parse CSR: %v", e)
	}
	want := map[string]bool{
		"a7k2p.example.com": true,
		"*.a7k2p.example.com": true,
		"custom.example.com": true,
		"deep.node.a7k2p.example.com": true,
	}
	if len(csr.DNSNames) != len(want) {
		t.Fatalf("CSR SANs = %#v, want %#v", csr.DNSNames, want)
	}
	for _, name := range csr.DNSNames {
		if !want[name] {
			t.Fatalf("unexpected redundant SAN %q", name)
		}
		delete(want, name)
	}
	if len(want) != 0 {
		t.Fatalf("missing SANs: %#v", want)
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
	sing := os.Getenv("SING_BOX_BINARY")
	if sing == "" {
		t.Skip("real sing-box path not supplied")
	}
	root := t.TempDir()
	makeCertificates(t, root)
	tlsTarget := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	tlsTarget.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	tlsTarget.EnableHTTP2 = true
	tlsTarget.StartTLS()
	defer tlsTarget.Close()
	makeState := func(hostID string, protocols []string) State {
		state := fixture()
		state.HostID = hostID
		for _, protocol := range protocols {
			item := service(protocol, 0)
			if protocol == "vless-reality" {
				item.RealityServer = "localhost"
				item.RealityPort = tlsTarget.Listener.Addr().(*net.TCPAddr).Port
			}
			state.Services = append(state.Services, item)
		}
		if err := state.Normalize(); err != nil {
			t.Fatal(err)
		}
		return state
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startServer := func(state State, name string) {
		t.Helper()
		path := filepath.Join(root, name+".json")
		cfg := SingBoxConfig(state, root)
		cfg["log"] = M{"level": "debug", "timestamp": true}
		data, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(sing, "check", "-c", path).CombinedOutput(); err != nil {
			t.Fatalf("server check: %v: %s", err, out)
		}
		logPath := filepath.Join(root, name+".log")
		output, err := os.Create(logPath)
		if err != nil {
			t.Fatal(err)
		}
		process := exec.CommandContext(ctx, sing, "run", "--disable-color", "-c", path)
		process.Stdout, process.Stderr = output, output
		if err = process.Start(); err != nil {
			output.Close()
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait(); _ = output.Close() })
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			contents, _ := os.ReadFile(logPath)
			if strings.Contains(string(contents), "sing-box started") {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		contents, _ := os.ReadFile(logPath)
		t.Fatalf("server %s not ready: %s", name, contents)
	}
	first := makeState("entry-host", []string{"hysteria2", "tuic", "anytls", "snell", "vless-ws", "vless-reality"})
	startServer(first, "entry")
	second := makeState("exit-host", []string{"anytls", "snell", "vless-ws", "vless-reality"})
	startServer(second, "exit")
	var latencyRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download" {
			_, _ = w.Write(make([]byte, 1000000))
		} else {
			latencyRequests.Add(1)
			w.WriteHeader(204)
		}
	}))
	defer target.Close()
	firstNodes, secondNodes := Export(first)["nodes"].([]any), Export(second)["nodes"].([]any)
	allNodes := append(append([]any{}, firstNodes...), secondNodes...)
	for _, raw := range allNodes {
		if raw.(M)["protocol"] != "vless-reality" {
			raw.(M)["insecure"] = true
		}
	}
	type configRequest struct {
		Nodes   []any    `json:"nodes"`
		NodeIDs []string `json:"nodeIds,omitempty"`
	}
	requests := []configRequest{}
	for _, node := range firstNodes {
		requests = append(requests, configRequest{Nodes: []any{node}})
	}
	names := []string{}
	for _, entry := range firstNodes {
		for _, exit := range secondNodes {
			requests = append(requests, configRequest{Nodes: allNodes, NodeIDs: []string{entry.(M)["id"].(string), exit.(M)["id"].(string)}})
			names = append(names, entry.(M)["protocol"].(string)+"-to-"+exit.(M)["protocol"].(string))
		}
	}
	input, _ := json.Marshal(requests)
	project, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	builder := exec.Command("node", "--import", "tsx", filepath.Join(project, "tests/runtime-configs.ts"))
	builder.Dir = project
	builder.Stdin = strings.NewReader(string(input))
	var diagnostics strings.Builder
	builder.Stderr = &diagnostics
	data, err := builder.Output()
	if err != nil {
		t.Fatalf("actual TypeScript runtime converter: %v: %s", err, diagnostics.String())
	}
	var configs []M
	if err = json.Unmarshal(data, &configs); err != nil || len(configs) != len(requests) {
		t.Fatalf("client configs: %v", err)
	}
	bin := t.TempDir()
	if err = os.Symlink(sing, filepath.Join(bin, "sing-box")); err != nil {
		t.Fatal(err)
	}
	manager := New(root, bin)
	run := func(t *testing.T, config M) {
		t.Helper()
		before := latencyRequests.Load()
		result, err := manager.Benchmark(BenchRequest{Config: config, LatencyURL: target.URL, DownloadURL: target.URL + "/download", DownloadBytes: 1000000, TimeoutMS: 15000, Speed: true})
		if err != nil {
			entry, _ := os.ReadFile(filepath.Join(root, "entry.log"))
			exit, _ := os.ReadFile(filepath.Join(root, "exit.log"))
			t.Fatalf("actual sing-box proxy request: %v\nentry log: %s\nexit log: %s", err, entry, exit)
		}
		if result["speedMBps"] == nil {
			t.Fatal("no actual download")
		}
		if got := latencyRequests.Load() - before; got != 2 {
			t.Fatalf("latency request count = %d, want 2", got)
		}
	}
	for i, node := range firstNodes {
		t.Run(node.(M)["protocol"].(string), func(t *testing.T) { run(t, configs[i]) })
	}
	for i, name := range names {
		config := configs[len(firstNodes)+i]
		if rejection, unsupported := config["unsupported"].(string); unsupported {
			t.Run("unsupported-chain/"+name, func(t *testing.T) {
				if !strings.Contains(rejection, "实测下载不稳定") {
					t.Fatal("unexpected capability rejection", rejection)
				}
			})
			continue
		}
		t.Run("chain-matrix/"+name, func(t *testing.T) { run(t, config) })
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

func TestWebsiteTCPListenerMaySharePortWithUDPService(t *testing.T) {
	s := fixture()
	s.Services = []Service{service("hysteria2", 38443)}
	s.Websites = []Website{{
		ID: "site", Domain: "site.example.com", Target: "127.0.0.1",
		TargetPort: 3000, Access: "direct", Port: 38443, PublicPort: 38443, EdgePort: 443,
	}}
	if err := s.Normalize(); err != nil {
		t.Fatalf("TCP website should be allowed to share numeric port with UDP service: %v", err)
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

func TestFilterServiceLogLinesFindsOpenRCCrashAndOOMDiagnostics(t *testing.T) {
	input := []byte(strings.Join([]string{
		"other-service started",
		"gungun-sing-box: failed to bind listener: address already in use",
		"kernel: Out of memory: Killed process 1234 (sing-box)",
		"unrelated message",
	}, "\n"))
	got := string(filterServiceLogLines(input, "gungun-sing-box", 20))
	for _, expected := range []string{
		"failed to bind listener",
		"Out of memory: Killed process",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("crash diagnostics missing %q: %s", expected, got)
		}
	}
	if strings.Contains(got, "other-service started") || strings.Contains(got, "unrelated message") {
		t.Fatalf("unrelated log lines should be filtered: %s", got)
	}
}

func TestTailLogLinesKeepsOnlyNewestEntries(t *testing.T) {
	got := string(tailLogLines([]byte("one\ntwo\nthree\nfour\n"), 2))
	if got != "three\nfour" {
		t.Fatalf("tailLogLines = %q", got)
	}
}

func TestVerifyOnceIncludesServiceNameAndLogsWhenServiceCrashed(t *testing.T) {
	m := fakeManager(t)
	m.InitSystem = "systemd"
	serviceLog := "sing-box: failed to bind listener: address already in use"
	m.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "systemctl" && len(args) >= 2 && args[0] == "is-active" {
			return []byte("failed"), errors.New("exit status 3")
		}
		if name == "journalctl" {
			return []byte(serviceLog), nil
		}
		return nil, nil
	}
	state := fixture()
	state.Services = []Service{service("vless-reality", 20001)}
	err := m.verifyOnce(state)
	if err == nil {
		t.Fatal("expected crashed service verification to fail")
	}
	if !strings.Contains(err.Error(), "gungun-sing-box") || !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("verification error should identify the failed service: %v", err)
	}
	diagnosed := m.withServiceLogs(state, err)
	for _, expected := range []string{
		"recent service logs",
		"failed to bind listener",
	} {
		if !strings.Contains(diagnosed.Error(), expected) {
			t.Fatalf("diagnostic error missing %q: %v", expected, diagnosed)
		}
	}
}

func TestOpenRCServiceActionUsesRunlevel(t *testing.T) {
	m := fakeManager(t)
	m.InitSystem = "openrc"
	var calls []string
	m.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(append([]string{name}, args...), " "))
		return []byte("ok"), nil
	}
	if _, err := m.ServiceAction("gungun-sing-box", "restart"); err != nil { t.Fatal(err) }
	want := "rc-update add gungun-sing-box default|rc-service gungun-sing-box restart"
	if strings.Join(calls, "|") != want { t.Fatalf("restart calls = %q, want %q", strings.Join(calls, "|"), want) }
	calls = nil
	if _, err := m.ServiceAction("gungun-sing-box", "stop"); err != nil { t.Fatal(err) }
	want = "rc-update del gungun-sing-box default|rc-service --ifstarted gungun-sing-box stop"
	if strings.Join(calls, "|") != want { t.Fatalf("stop calls = %q, want %q", strings.Join(calls, "|"), want) }
}

func TestTunnelReadinessRequiresConnectedConnector(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	if err := checkTunnelReady(healthy.Client(), healthy.URL+"/ready"); err != nil {
		t.Fatalf("healthy connector rejected: %v", err)
	}

	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()
	if err := checkTunnelReady(unhealthy.Client(), unhealthy.URL+"/ready"); err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("unhealthy connector accepted: %v", err)
	}
}


func TestSpeedTrackerReportsAverageAndPeak(t *testing.T) {
	start := time.Unix(1700000000, 0)
	tracker := newSpeedTracker(start)
	tracker.add(1_000_000, start.Add(time.Second))
	tracker.add(3_000_000, start.Add(2*time.Second))
	average, peak := tracker.finish(start.Add(2 * time.Second))
	if average != 2 {
		t.Fatalf("average speed = %.2f MB/s, want 2.00", average)
	}
	if peak != 3 {
		t.Fatalf("peak speed = %.2f MB/s, want 3.00", peak)
	}
}


func TestSharedCamouflageUsesLoopbackStaticSite(t *testing.T) {
	state := fixture()
	state.Camouflage = &CamouflageSite{Domain: "web-a7k2p.example.com", Port: 20002}
	if err := state.Normalize(); err != nil { t.Fatal(err) }
	config := CaddyConfig(state, "/etc/gungun")
	servers := config["apps"].(M)["http"].(M)["servers"].(M)
	server := servers["port_20002"].(M)
	if server["listen"].([]string)[0] != "127.0.0.1:20002" {
		t.Fatalf("shared site must only listen on loopback: %#v", server["listen"])
	}
	routes := server["routes"].([]any)
	if len(routes) != 1 { t.Fatalf("expected one static route, got %d", len(routes)) }
	handler := routes[0].(M)["handle"].([]any)[0].(M)
	if handler["handler"] != "static_response" || handler["status_code"] != 200 {
		t.Fatalf("unexpected static site handler: %#v", handler)
	}
}

func TestSharedCamouflagePortCannotCollide(t *testing.T) {
	state := fixture()
	state.Services = []Service{service("snell", 20002)}
	state.Camouflage = &CamouflageSite{Domain: "web-a7k2p.example.com", Port: 20002}
	if err := state.Normalize(); err == nil {
		t.Fatal("shared site port collision must be rejected")
	}
}


func TestVlessWSNodeDomainUsesSharedCamouflageFallback(t *testing.T) {
	state := fixture()
	direct := service("vless-ws", 45516)
	direct.Domain = "vless-ws-direct.a7k2p.example.com"
	direct.PublicPort = 45516
	argo := direct
	argo.ID = "vless-ws-argo"
	argo.Access = "argo"
	argo.Domain = "vless-ws-argo.a7k2p.example.com"
	argo.PublicPort = 0
	state.Services = []Service{direct, argo}
	if err := state.Normalize(); err != nil { t.Fatal(err) }

	config := CaddyConfig(state, "/etc/gungun")
	servers := config["apps"].(M)["http"].(M)["servers"].(M)
	server := servers["port_45516"].(M)
	if server["listen"].([]string)[0] != ":45516" {
		t.Fatalf("direct + Argo shared listener must be publicly reachable: %#v", server["listen"])
	}
	routes := server["routes"].([]any)
	if len(routes) != 4 { t.Fatalf("expected proxy + fallback routes for each domain, got %d", len(routes)) }
	proxy := routes[0].(M)
	match := proxy["match"].([]any)[0].(M)
	if match["host"].([]string)[0] != direct.Domain || match["path"].([]string)[0] != "/gungun" {
		t.Fatalf("WebSocket route must match the node host and path: %#v", match)
	}
	handler := proxy["handle"].([]any)[0].(M)
	upstream := handler["upstreams"].([]any)[0].(M)
	if upstream["dial"] != fmt.Sprintf("127.0.0.1:%d", state.Services[0].BackendPort) {
		t.Fatalf("WebSocket route must target loopback sing-box backend: %#v", upstream)
	}
	fallback := routes[1].(M)["handle"].([]any)[0].(M)
	if fallback["handler"] != "static_response" || fallback["status_code"] != 200 {
		t.Fatalf("ordinary browser paths must return the shared static page: %#v", fallback)
	}
	if _, ok := config["apps"].(M)["tls"]; !ok { t.Fatal("Caddy must load the source certificate for node domains") }
}

func TestCaddyDisablesHTTP3WhenTLSPortIsSharedWithUDPProxy(t *testing.T) {
	state := fixture()
	tuic := service("tuic", 48001)
	site := Website{
		ID: "site",
		Domain: "site.a7k2p.example.com",
		Target: "127.0.0.1",
		TargetPort: 8080,
		Access: "direct",
		Port: 48001,
		PublicPort: 48001,
		EdgePort: 443,
	}
	state.Services = []Service{tuic}
	state.Websites = []Website{site}
	if err := state.Normalize(); err != nil {
		t.Fatalf("TCP HTTPS and UDP TUIC may share a numeric port: %v", err)
	}

	config := CaddyConfig(state, "/etc/gungun")
	servers := config["apps"].(M)["http"].(M)["servers"].(M)
	server := servers["port_48001"].(M)
	protocols, ok := server["protocols"].([]string)
	if !ok {
		t.Fatalf("Caddy TLS listener must declare protocols when sharing a UDP port: %#v", server["protocols"])
	}
	if strings.Join(protocols, ",") != "h1,h2" {
		t.Fatalf("Caddy protocols = %#v, want only h1 and h2 to avoid TUIC UDP collision", protocols)
	}
	if _, ok := server["tls_connection_policies"]; !ok {
		t.Fatal("disabling HTTP/3 must preserve HTTPS/TLS on TCP")
	}
}

func TestArgoOnlyVlessWSCaddyListenerIsLoopback(t *testing.T) {
	state := fixture()
	v := service("vless-ws", 45516)
	v.Access = "argo"
	v.Domain = "vless-ws-argo.a7k2p.example.com"
	v.PublicPort = 0
	state.Services = []Service{v}
	if err := state.Normalize(); err != nil { t.Fatal(err) }
	config := CaddyConfig(state, "/etc/gungun")
	server := config["apps"].(M)["http"].(M)["servers"].(M)["port_45516"].(M)
	if server["listen"].([]string)[0] != "127.0.0.1:45516" {
		t.Fatalf("Argo-only listener must bind to loopback: %#v", server["listen"])
	}
}
