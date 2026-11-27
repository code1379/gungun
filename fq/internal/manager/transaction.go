package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Runner func(context.Context, string, ...string) ([]byte, error)
type Manager struct {
	Root string
	Bin string
	Run Runner
	Verify func(State) error
	InitSystem string
}

func Exec(ctx context.Context, name string, args ...string) ([]byte, error) {
	out, e := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if e != nil {
		return out, fmt.Errorf("%s: %w: %s", name, e, string(out))
	}
	return out, nil
}
func New(root, bin string) *Manager {
	m := &Manager{Root: root, Bin: bin, Run: Exec}
	m.Verify = m.verify
	return m
}
func (m *Manager) Command(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return m.Run(ctx, name, args...)
}
func (m *Manager) Lock() (func(), error) {
	if e := os.MkdirAll(m.Root, 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(filepath.Join(m.Root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another fq operation is running")
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
func (m *Manager) Load() (State, error) {
	var s State
	b, e := os.ReadFile(filepath.Join(m.Root, "state.json"))
	if errors.Is(e, os.ErrNotExist) {
		return State{SchemaVersion: 1, Services: []Service{}, Websites: []Website{}}, nil
	}
	if e != nil {
		return s, e
	}
	e = json.Unmarshal(b, &s)
	return s, e
}
func AtomicWrite(path string, b []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".fq-write-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(mode); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(name, path)
}

var managedFiles = []string{"state.json", "sing-box.json", "caddy.json", "tunnel.env", "key.pem", "cert.pem", "sing-box.enabled", "caddy.enabled", "tunnel.enabled"}

func caddyRequired(s State) bool {
	return len(s.Websites) > 0 || s.Camouflage != nil
}

func (m *Manager) Backup() (string, error) {
	id := time.Now().UTC().Format("20060102T150405.000000000Z")
	dir := filepath.Join(m.Root, "backups", id)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	manifest := map[string]string{}
	for _, name := range managedFiles {
		manifest[name] = ""
		b, e := os.ReadFile(filepath.Join(m.Root, name))
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return "", e
		}
		if e = AtomicWrite(filepath.Join(dir, name), b, 0600); e != nil {
			return "", e
		}
		digest := sha256.Sum256(b)
		manifest[name] = hex.EncodeToString(digest[:])
	}
	data, e := json.Marshal(manifest)
	if e != nil { return "", e }
	if e = AtomicWrite(filepath.Join(dir, "manifest.json"), data, 0600); e != nil { return "", e }
	return id, nil
}
func (m *Manager) RestoreFiles(id string) error {
	if filepath.Base(id) != id || !strings.HasSuffix(id, "Z") {
		return errors.New("invalid backup id")
	}
	dir := filepath.Join(m.Root, "backups", id)
	info, e := os.Stat(dir)
	if e != nil || !info.IsDir() {
		return errors.New("backup not found")
	}
	data, e := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if e != nil { return fmt.Errorf("incomplete backup: %w", e) }
	manifest := map[string]string{}
	if e = json.Unmarshal(data, &manifest); e != nil || len(manifest) != len(managedFiles) {
		return errors.New("invalid backup manifest")
	}
	verified := map[string][]byte{}
	for _, name := range managedFiles {
		expected, exists := manifest[name]
		if !exists { return errors.New("incomplete backup manifest") }
		if expected == "" { continue }
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil { return fmt.Errorf("backup file %s: %w", name, err) }
		digest := sha256.Sum256(b)
		if hex.EncodeToString(digest[:]) != expected { return fmt.Errorf("backup checksum mismatch: %s", name) }
		verified[name] = b
	}
	for _, name := range managedFiles {
		if manifest[name] == "" {
			if e = os.Remove(filepath.Join(m.Root, name)); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
			continue
		}
		if e = AtomicWrite(filepath.Join(m.Root, name), verified[name], 0600); e != nil {
			return e
		}
	}
	return nil
}
func (m *Manager) precheck(s State, dir string) error {
	if len(s.Services) > 0 {
		if _, e := m.Command(filepath.Join(m.Bin, "sing-box"), "check", "-c", filepath.Join(dir, "sing-box.json")); e != nil {
			return e
		}
	}
	if caddyRequired(s) {
		if _, e := m.Command(filepath.Join(m.Bin, "caddy"), "validate", "--config", filepath.Join(dir, "caddy.json")); e != nil { return e }
	}
	for _, v := range s.Services {
		if v.Egress == "WARP" {
			if _, e := m.Command("warp-cli", "--accept-tos", "status"); e != nil {
				return fmt.Errorf("WARP unavailable: %w", e)
			}
		}
	}
	return nil
}
func (m *Manager) restart(s State) error {
	for _, item := range []struct {
		name    string
		enabled bool
	}{{"sing-box", len(s.Services) > 0}, {"caddy", len(s.Websites) > 0}, {"tunnel", s.TunnelToken != ""}} {
		path := filepath.Join(m.Root, item.name+".enabled")
		if item.enabled {
			if e := AtomicWrite(path, []byte("enabled\n"), 0600); e != nil {
				return e
			}
		} else {
			if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
				return e
			}
		}
	}

	for _, item := range []struct {
		name    string
		enabled bool
	}{{"gungun-sing-box", len(s.Services) > 0}, {"gungun-caddy", caddyRequired(s)}, {"gungun-tunnel", s.TunnelToken != ""}} {
		verb := "stop"
		if item.enabled { verb = "restart" }
		if _, e := m.ServiceAction(item.name, verb); e != nil {
			log, _ := m.ServiceLogs(item.name, 30)
			return fmt.Errorf("%w; recent log: %s", e, log)
		}
	}
	return nil
}
func (m *Manager) Apply(s State) (M, error) {
	old, e := m.Load()
	if e != nil {
		return nil, e
	}
	if s.RealityPrivateKey == "" {
		s.RealityPrivateKey = old.RealityPrivateKey
		s.RealityPublicKey = old.RealityPublicKey
		s.RealityShortID = old.RealityShortID
	}
	if s.DisableTunnel {
		s.TunnelToken = ""
	} else if s.TunnelToken == "" {
		s.TunnelToken = old.TunnelToken
	}
	s.Certificate = old.Certificate
	if e = s.Normalize(); e != nil {
		return nil, e
	}
	backup, e := m.Backup()
	if e != nil {
		return nil, e
	}
	stage, e := os.MkdirTemp(m.Root, ".stage-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(stage)
	files := map[string]any{"sing-box.json": SingBoxConfig(s, m.Root), "caddy.json": CaddyConfig(s, m.Root), "state.json": s}
	for name, obj := range files {
		b, e := json.MarshalIndent(obj, "", "  ")
		if e != nil {
			return nil, e
		}
		if e = AtomicWrite(filepath.Join(stage, name), b, 0600); e != nil {
			return nil, e
		}
	}
	if strings.ContainsAny(s.TunnelToken, "\n\r\"\\") {
		return nil, errors.New("invalid tunnel token")
	}
	if e = AtomicWrite(filepath.Join(stage, "tunnel.env"), []byte("TUNNEL_TOKEN="+s.TunnelToken+"\n"), 0600); e != nil {
		return nil, e
	}
	if e = m.precheck(s, stage); e != nil {
		return nil, fmt.Errorf("precheck failed (backup %s): %w", backup, e)
	}
	rollback := func(cause error) (M, error) {
		r := m.RestoreFiles(backup)
		if r == nil {
			r = m.restart(old)
		}
		if r == nil {
			r = m.Verify(old)
		}
		if r != nil {
			return nil, fmt.Errorf("apply failed: %v; ROLLBACK FAILED: %v; backup %s", cause, r, backup)
		}
		return nil, fmt.Errorf("apply failed, rolled back to %s: %w", backup, cause)
	}
	for name := range files {
		b, e := os.ReadFile(filepath.Join(stage, name))
		if e != nil {
			return rollback(e)
		}
		if e = AtomicWrite(filepath.Join(m.Root, name), b, 0600); e != nil {
			return rollback(e)
		}
	}
	b, e := os.ReadFile(filepath.Join(stage, "tunnel.env"))
	if e != nil {
		return rollback(e)
	}
	if e = AtomicWrite(filepath.Join(m.Root, "tunnel.env"), b, 0600); e != nil {
		return rollback(e)
	}
	if e = m.restart(s); e != nil {
		return rollback(e)
	}
	if e = m.Verify(s); e != nil {
		return rollback(e)
	}
	return M{"ok": true, "backupId": backup}, nil
}
func redactedState(s State) State              { s.TunnelToken = ""; s.RealityPrivateKey = ""; return s }
func (m *Manager) PublicState() (State, error) { s, e := m.Load(); return redactedState(s), e }
func (m *Manager) verify(s State) error {
	var last error
	attempts := 40
	if s.TunnelToken != "" {
		// cloudflared needs time to establish its outbound connections and report /ready.
		attempts = 150
	}
	for attempt := 0; attempt < attempts; attempt++ {
		last = m.verifyOnce(s)
		if last == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return last
}

func checkTunnelReady(client *http.Client, endpoint string) error {
	response, err := client.Get(endpoint)
	if err != nil {
		return fmt.Errorf("Cloudflare Tunnel connector is not ready: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Cloudflare Tunnel connector is not connected: /ready returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (m *Manager) verifyOnce(s State) error {
	for _, item := range []struct {
		name    string
		enabled bool
	}{{"gungun-sing-box", len(s.Services) > 0}, {"gungun-caddy", caddyRequired(s)}, {"gungun-tunnel", s.TunnelToken != ""}} {
		if item.enabled {
			if _, e := m.ServiceAction(item.name, "status"); e != nil { return e }
		}
	}
	if s.TunnelToken != "" {
		client := &http.Client{Timeout: 500 * time.Millisecond}
		if err := checkTunnelReady(client, "http://"+tunnelMetricsAddress+"/ready"); err != nil {
			return err
		}
	}
	for _, v := range s.Services {
		if v.Protocol == "tuic" || v.Protocol == "hysteria2" {
			out, e := m.Command("ss", "-H", "-lnu", "sport", "=", fmt.Sprintf(":%d", v.Port))
			if e != nil {
				return e
			}
			if len(bytes.TrimSpace(out)) == 0 {
				return fmt.Errorf("UDP port %d not listening", v.Port)
			}
			continue
		}
		conn, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", v.Port), 500*time.Millisecond)
		if e != nil {
			return fmt.Errorf("listen verification: %w", e)
		}
		conn.Close()
	}
	if s.Camouflage != nil {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", s.Camouflage.Port), 500*time.Millisecond)
		if err != nil { return fmt.Errorf("shared camouflage listener verification: %w", err) }
		conn.Close()
	}
	for _, w := range s.Websites {
		conn, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", w.Port), 500*time.Millisecond)
		if e != nil {
			return fmt.Errorf("website listener: %w", e)
		}
		conn.Close()
	}
	return nil
}

func Decode(reader io.Reader, target any) error {
	d := json.NewDecoder(io.LimitReader(reader, 4<<20))
	d.DisallowUnknownFields()
	if e := d.Decode(target); e != nil {
		return e
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}
func (m *Manager) Restore(id string) (M, error) {
	current, e := m.Backup()
	if e != nil {
		return nil, e
	}
	if e = m.RestoreFiles(id); e != nil {
		return nil, e
	}
	s, e := m.Load()
	if e == nil {
		e = m.precheck(s, m.Root)
	}
	if e == nil {
		e = m.restart(s)
	}
	if e == nil {
		e = m.Verify(s)
	}
	if e != nil {
		rollback := m.RestoreFiles(current)
		if rollback == nil {
			old, load := m.Load()
			rollback = load
			if rollback == nil {
				rollback = m.restart(old)
			}
		}
		return nil, fmt.Errorf("restore failed: %v; rollback: %v", e, rollback)
	}
	return M{"ok": true, "backupId": current}, nil
}
func EqualJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
