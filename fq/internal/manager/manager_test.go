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
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download" {
			_, _ = w.Write(make([]byte, 1000000))
		} else {
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
		result, err := manager.Benchmark(BenchRequest{Config: config, LatencyURL: target.URL, DownloadURL: target.URL + "/download", DownloadBytes: 1000000, TimeoutMS: 15000, Speed: true})
		if err != nil {
			entry, _ := os.ReadFile(filepath.Join(root, "entry.log"))
			exit, _ := os.ReadFile(filepath.Join(root, "exit.log"))
			t.Fatalf("actual sing-box proxy request: %v\nentry log: %s\nexit log: %s", err, entry, exit)
		}
		if result["speedMBps"] == nil {
			t.Fatal("no actual download")
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
