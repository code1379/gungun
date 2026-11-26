package manager

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var HTTPClient = &http.Client{Timeout: 2 * time.Minute}

type Asset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
}

func DownloadRelease(repo, tag, name string) ([]byte, error) {
	req, e := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/tags/"+tag, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", "gungun-fq")
	r, e := HTTPClient.Do(req)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("release metadata HTTP %d", r.StatusCode)
	}
	var release struct {
		Assets []Asset `json:"assets"`
	}
	if e = json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&release); e != nil {
		return nil, e
	}
	var asset *Asset
	for i := range release.Assets {
		if release.Assets[i].Name == name {
			asset = &release.Assets[i]
			break
		}
	}
	if asset == nil || !strings.HasPrefix(asset.Digest, "sha256:") {
		return nil, errors.New("release asset or SHA256 digest missing")
	}
	if !strings.HasPrefix(asset.URL, "https://github.com/"+repo+"/releases/download/") {
		return nil, errors.New("invalid release URL")
	}
	res, e := HTTPClient.Get(asset.URL)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("asset HTTP %d", res.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 150<<20))
	if e != nil {
		return nil, e
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != strings.TrimPrefix(asset.Digest, "sha256:") {
		return nil, errors.New("asset SHA256 mismatch")
	}
	return b, nil
}
func ExtractExecutable(b []byte, archive, target string) ([]byte, error) {
	if !strings.HasSuffix(archive, ".gz") {
		return b, nil
	}
	gz, e := gzip.NewReader(strings.NewReader(string(b)))
	if e != nil {
		return nil, e
	}
	defer gz.Close()
	if !strings.HasSuffix(archive, ".tar.gz") {
		return io.ReadAll(io.LimitReader(gz, 200<<20))
	}
	reader := tar.NewReader(gz)
	for {
		header, e := reader.Next()
		if e == io.EOF {
			return nil, errors.New("binary missing in archive")
		}
		if e != nil {
			return nil, e
		}
		if filepath.Base(header.Name) == target && header.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(reader, 200<<20))
		}
	}
}
func (m *Manager) InstallCore(name string) (M, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("fq service installation requires Linux")
	}
	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return nil, errors.New("only amd64/arm64 supported")
	}
	repo, tag, asset := "", "", ""
	switch name {
	case "sing-box":
		repo = "SagerNet/sing-box"
		tag = "v1.14.4"
		asset = "sing-box-1.14.4-linux-" + arch + ".tar.gz"
	case "mihomo":
		repo = "MetaCubeX/mihomo"
		tag = "v1.19.34"
		flavor := arch
		if arch == "amd64" {
			flavor = "amd64-compatible"
		}
		asset = "mihomo-linux-" + flavor + "-v1.19.34.gz"
	case "cloudflared":
		repo = "cloudflare/cloudflared"
		tag = "2026.11.2"
		asset = "cloudflared-linux-" + arch
	case "caddy":
		repo = "caddyserver/caddy"
		tag = "v2.10.2"
		asset = "caddy_2.10.2_linux_" + arch + ".tar.gz"
	default:
		return nil, errors.New("unknown core")
	}
	b, e := DownloadRelease(repo, tag, asset)
	if e != nil {
		return nil, e
	}
	binary, e := ExtractExecutable(b, asset, name)
	if e != nil {
		return nil, e
	}
	path := filepath.Join(m.Bin, name)
	previous, _ := os.ReadFile(path)
	if e = AtomicWrite(path, binary, 0755); e != nil {
		return nil, e
	}
	versionArg := "version"
	if name == "cloudflared" {
		versionArg = "--version"
	}
	if name == "mihomo" {
		versionArg = "-v"
	}
	rollback := func(cause error) (M, error) {
		var undo error
		if previous != nil {
			undo = AtomicWrite(path, previous, 0755)
		} else {
			undo = os.Remove(path)
		}
		return nil, errors.Join(cause, undo)
	}
	out, e := m.Command(path, versionArg)
	if e != nil {
		return rollback(e)
	}
	state, e := m.Load()
	if e != nil {
		return rollback(e)
	}
	unit := ""
	switch name {
	case "sing-box":
		if len(state.Services) > 0 {
			unit = "gungun-sing-box"
			if _, e = m.Command(path, "check", "-c", filepath.Join(m.Root, "sing-box.json")); e != nil {
				return rollback(e)
			}
		}
	case "caddy":
		if len(state.Websites) > 0 {
			unit = "gungun-caddy"
			if _, e = m.Command(path, "validate", "--config", filepath.Join(m.Root, "caddy.json")); e != nil {
				return rollback(e)
			}
		}
	case "cloudflared":
		if state.TunnelToken != "" {
			unit = "gungun-tunnel"
		}
	}
	if unit != "" {
		_, _ = m.Command("systemctl", "reset-failed", unit)
		if _, e = m.Command("systemctl", "restart", unit); e == nil {
			e = m.Verify(state)
		}
		if e != nil {
			_, undo := rollback(e)
			_, _ = m.Command("systemctl", "reset-failed", unit)
			_, restart := m.Command("systemctl", "restart", unit)
			return nil, errors.Join(undo, restart)
		}
	}

	return M{"ok": true, "core": name, "version": strings.TrimSpace(string(out))}, nil
}
func (m *Manager) InstallUnits() error {
	units := map[string]string{
		"gungun-sing-box": "ExecStart=" + m.Bin + "/sing-box run -c " + m.Root + "/sing-box.json\n",
		"gungun-caddy":    "ExecStart=" + m.Bin + "/caddy run --config " + m.Root + "/caddy.json\n",
		"gungun-tunnel":   "EnvironmentFile=" + m.Root + "/tunnel.env\nExecStart=" + m.Bin + "/cloudflared tunnel --no-autoupdate run\n",
	}
	for name, command := range units {
		data := "[Unit]\nDescription=Gungun managed " + name + "\nAfter=network-online.target\nWants=network-online.target\nConditionPathExists=" + m.Root + "/state.json\nConditionPathExists=" + m.Root + "/" + strings.TrimPrefix(name, "gungun-") + ".enabled\n[Service]\n" + command + "StateDirectory=" + name + "\nEnvironment=XDG_DATA_HOME=/var/lib/" + name + "\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nProtectHome=true\nProtectSystem=full\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n"
		if e := AtomicWrite("/etc/systemd/system/"+name+".service", []byte(data), 0644); e != nil {
			return e
		}
	}
	if _, e := m.Command("systemctl", "daemon-reload"); e != nil {
		return e
	}
	_, e := m.Command("systemctl", "enable", "gungun-sing-box", "gungun-caddy", "gungun-tunnel")
	return e
}
func (m *Manager) UpdateSelf(version string) (M, error) {
	if !strings.HasPrefix(version, "v") || strings.ContainsAny(version, "/\\ ") {
		return nil, errors.New("explicit release version required")
	}
	name := "fq-linux-" + runtime.GOARCH
	b, e := DownloadRelease("code1379/gungun", version, name)
	if e != nil {
		return nil, e
	}
	path, e := os.Executable()
	if e != nil {
		return nil, e
	}
	return M{"ok": true, "version": version}, AtomicWrite(path, b, 0755)
}
