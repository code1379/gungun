package manager

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const tunnelMetricsAddress = "127.0.0.1:20241"

func serviceCommandPath(name string, fallback ...string) (string, bool) {
	if path, err := exec.LookPath(name); err == nil {
		return path, true
	}
	for _, path := range fallback {
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() && info.Mode().Perm()&0111 != 0 {
			return path, true
		}
	}
	return "", false
}

func (m *Manager) serviceBackend() (string, error) {
	if m.InitSystem != "" {
		if m.InitSystem == "systemd" || m.InitSystem == "openrc" {
			return m.InitSystem, nil
		}
		return "", fmt.Errorf("unsupported service manager: %s", m.InitSystem)
	}
	if _, err := os.Stat("/run/systemd/system"); err == nil {
		if _, ok := serviceCommandPath("systemctl", "/usr/bin/systemctl", "/bin/systemctl"); ok {
			return "systemd", nil
		}
	}
	_, hasService := serviceCommandPath("rc-service", "/sbin/rc-service", "/usr/sbin/rc-service")
	_, hasUpdate := serviceCommandPath("rc-update", "/sbin/rc-update", "/usr/sbin/rc-update")
	_, hasOpenRC := serviceCommandPath("openrc-run", "/sbin/openrc-run", "/usr/sbin/openrc-run")
	if hasService && hasUpdate && hasOpenRC {
		return "openrc", nil
	}
	return "", errors.New("unsupported service manager: requires systemd or OpenRC (Alpine Linux)")
}

func (m *Manager) runServiceCommand(name string, args ...string) ([]byte, error) {
	var fallback []string
	switch name {
	case "systemctl":
		fallback = []string{"/usr/bin/systemctl", "/bin/systemctl"}
	case "journalctl":
		fallback = []string{"/usr/bin/journalctl", "/bin/journalctl"}
	case "rc-service":
		fallback = []string{"/sbin/rc-service", "/usr/sbin/rc-service"}
	case "rc-update":
		fallback = []string{"/sbin/rc-update", "/usr/sbin/rc-update"}
	default:
		return nil, fmt.Errorf("unknown service command: %s", name)
	}
	path := name
	if m.InitSystem == "" {
		var ok bool
		path, ok = serviceCommandPath(name, fallback...)
		if !ok {
			return nil, fmt.Errorf("service command %s not found in PATH or standard paths", name)
		}
	}
	return m.Command(path, args...)
}

func (m *Manager) ServiceAction(name, action string) ([]byte, error) {
	allowed := map[string]bool{
		"gungun-sing-box": true,
		"gungun-caddy":    true,
		"gungun-tunnel":   true,
		"warp-svc":        true,
	}
	if !allowed[name] {
		return nil, fmt.Errorf("invalid service: %s", name)
	}
	switch action {
	case "start", "stop", "restart", "status", "enable", "disable":
	default:
		return nil, fmt.Errorf("invalid action: %s", action)
	}
	backend, err := m.serviceBackend()
	if err != nil {
		return nil, err
	}
	if backend == "systemd" {
		if action == "status" {
			return m.runServiceCommand("systemctl", "is-active", name)
		}
		return m.runServiceCommand("systemctl", action, name)
	}
	if action == "enable" {
		return m.runServiceCommand("rc-update", "add", name, "default")
	}
	if action == "disable" {
		_, _ = m.runServiceCommand("rc-service", "--ifstarted", name, "stop")
		return m.runServiceCommand("rc-update", "del", name, "default")
	}
	if action == "stop" {
		_, _ = m.runServiceCommand("rc-update", "del", name, "default")
		return m.runServiceCommand("rc-service", "--ifstarted", name, "stop")
	}
	if action == "restart" {
		if _, err := m.runServiceCommand("rc-update", "add", name, "default"); err != nil {
			return nil, err
		}
		out, err := m.runServiceCommand("rc-service", name, "restart")
		if err == nil {
			return out, nil
		}
		started, startErr := m.runServiceCommand("rc-service", name, "start")
		if startErr == nil {
			return started, nil
		}
		return nil, errors.Join(err, startErr)
	}
	if action == "start" {
		if _, err := m.runServiceCommand("rc-update", "add", name, "default"); err != nil {
			return nil, err
		}
	}
	return m.runServiceCommand("rc-service", name, action)
}

func (m *Manager) ServiceLogs(name string, lines int) ([]byte, error) {
	if lines < 1 {
		lines = 50
	}
	if lines > 500 {
		lines = 500
	}
	backend, err := m.serviceBackend()
	if err != nil {
		return nil, err
	}
	if backend == "systemd" {
		return m.runServiceCommand("journalctl", "-u", name, "-n", fmt.Sprint(lines), "--no-pager", "-o", "short-iso")
	}
	path := filepath.Join("/var/log", name+".log")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("OpenRC log unavailable at %s: %w", path, err)
	}
	rows := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(rows) > lines {
		rows = rows[len(rows)-lines:]
	}
	return []byte(strings.Join(rows, "\n")), nil
}

func systemdUnit(name, command, root string) string {
	environmentFile := ""
	if name == "gungun-tunnel" {
		environmentFile = "EnvironmentFile=" + root + "/tunnel.env\n"
	}
	return "[Unit]\n" +
		"Description=Gungun managed " + name + "\n" +
		"After=network-online.target\n" +
		"Wants=network-online.target\n" +
		"ConditionPathExists=" + root + "/state.json\n" +
		"ConditionPathExists=" + root + "/" + strings.TrimPrefix(name, "gungun-") + ".enabled\n" +
		"[Service]\n" + environmentFile +
		"ExecStart=" + command + "\n" +
		"Restart=on-failure\n" +
		"RestartSec=3\n" +
		"UMask=0077\n" +
		"NoNewPrivileges=true\n" +
		"ProtectHome=true\n" +
		"ProtectSystem=full\n" +
		"PrivateTmp=true\n" +
		"[Install]\n" +
		"WantedBy=multi-user.target\n"
}

func openRCUnit(name, command, args, root string) string {
	tokenSetup := ""
	if name == "gungun-tunnel" {
		tokenPath := root + "/tunnel.env"
		tokenSetup = "start_pre() {\n" +
			"  [ -r " + tokenPath + " ] || return 1\n" +
			"  TUNNEL_TOKEN=\"$(sed -n 's/^TUNNEL_TOKEN=//p' " + tokenPath + ")\"\n" +
			"  [ -n \"$TUNNEL_TOKEN\" ] || return 1\n" +
			"  export TUNNEL_TOKEN\n" +
			"}\n"
	}
	return "#!/sbin/openrc-run\n" +
		"name=\"" + name + "\"\n" +
		"command=\"" + command + "\"\n" +
		"command_args=\"" + args + "\"\n" +
		"command_background=true\n" +
		"pidfile=\"/run/${RC_SVCNAME}.pid\"\n" +
		"output_log=\"/var/log/" + name + ".log\"\n" +
		"error_log=\"/var/log/" + name + ".log\"\n" +
		"depend() { need net; }\n" +
		tokenSetup
}

func (m *Manager) InstallServices() error {
	backend, err := m.serviceBackend()
	if err != nil {
		return err
	}
	commands := map[string]string{
		"gungun-sing-box": m.Bin + "/sing-box run -c " + m.Root + "/sing-box.json",
		"gungun-caddy":    m.Bin + "/caddy run --config " + m.Root + "/caddy.json",
		"gungun-tunnel":   m.Bin + "/cloudflared tunnel --no-autoupdate --metrics " + tunnelMetricsAddress + " run",
	}
	if backend == "systemd" {
		for name, command := range commands {
			data := systemdUnit(name, command, m.Root)
			if err := AtomicWrite("/etc/systemd/system/"+name+".service", []byte(data), 0644); err != nil {
				return err
			}
		}
		if _, err := m.runServiceCommand("systemctl", "daemon-reload"); err != nil {
			return err
		}
		for name := range commands {
			if _, err := m.ServiceAction(name, "enable"); err != nil {
				return err
			}
		}
		return nil
	}
	for name, commandLine := range commands {
		parts := strings.SplitN(commandLine, " ", 2)
		args := ""
		if len(parts) == 2 {
			args = parts[1]
		}
		data := openRCUnit(name, parts[0], args, m.Root)
		if err := AtomicWrite("/etc/init.d/"+name, []byte(data), 0755); err != nil {
			return err
		}
		if _, err := m.ServiceAction(name, "enable"); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) UninstallServices() error {
	backend, err := m.serviceBackend()
	if err != nil {
		return err
	}
	for _, name := range []string{"gungun-sing-box", "gungun-caddy", "gungun-tunnel"} {
		_, _ = m.ServiceAction(name, "disable")
		if backend == "systemd" {
			_ = os.Remove("/etc/systemd/system/" + name + ".service")
		} else {
			_ = os.Remove("/etc/init.d/" + name)
		}
	}
	if backend == "systemd" {
		_, err = m.Command("systemctl", "daemon-reload")
	}
	return err
}
