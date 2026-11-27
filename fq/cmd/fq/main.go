package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/code1379/gungun/fq/internal/manager"
	"os"
	"path/filepath"
	"strings"
)

var version = "dev"

func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
func marshal(v any) ([]byte, error) { return json.MarshalIndent(v, "", "  ") }
func run(args []string) error {
	if len(args) == 0 {
		fmt.Println("fq " + version + "\nCommands: status list log restart update core warp backup restore export config apply install cert bench uninstall\nUse --json for structured output. apply reads schemaVersion=1 JSON from stdin.")
		return nil
	}
	filtered := []string{}
	asJSON := false
	for _, arg := range args {
		if arg == "--json" {
			asJSON = true
		} else {
			filtered = append(filtered, arg)
		}
	}
	args = filtered
	if len(args) == 0 {
		return errors.New("command required")
	}
	m := manager.New(env("FQ_ROOT", "/etc/gungun"), env("FQ_BIN", "/usr/local/lib/gungun"))
	var result any
	var e error
	if args[0] == "version" {
		result = manager.M{"version": version}
	} else if args[0] == "bench" {
		var input manager.BenchRequest
		if e = manager.Decode(os.Stdin, &input); e != nil {
			return e
		}
		result, e = m.Benchmark(input)
	} else {
		if args[0] != "status" && args[0] != "log" {
			unlock, err := m.Lock()
			if err != nil {
				return err
			}
			defer unlock()
		}
		switch args[0] {
		case "config":
			result, e = m.PublicState()
		case "export":
			var state manager.State
			state, e = m.Load()
			if e == nil {
				result = manager.Export(state)
			}
		case "list":
			var state manager.State
			state, e = m.Load()
			if e == nil {
				for i := range state.Services {
					state.Services[i].Password = "[redacted]"
					state.Services[i].UUID = "[redacted]"
				}
				result = manager.M{"services": state.Services, "websites": state.Websites}
			}
		case "apply":
			var state manager.State
			if e = manager.Decode(os.Stdin, &state); e == nil {
				result, e = m.Apply(state)
			}
		case "status":
			statuses := manager.M{}
			for _, name := range []string{"gungun-sing-box", "gungun-caddy", "gungun-tunnel", "warp-svc"} {
				out, err := m.Command("systemctl", "is-active", name)
				statuses[name] = manager.M{"active": err == nil, "status": strings.TrimSpace(string(out))}
			}
			result = manager.M{"version": version, "services": statuses}
			if out, err := m.Command("tailscale", "status", "--json"); err == nil {
				var ts any
				if json.Unmarshal(out, &ts) == nil {
					result.(manager.M)["tailscale"] = ts
				}
			}
		case "log":
			unit := "gungun-sing-box"
			if len(args) > 1 {
				unit = args[1]
			}
			if unit != "gungun-sing-box" && unit != "gungun-caddy" && unit != "gungun-tunnel" {
				return errors.New("invalid log unit")
			}
			out, err := m.Command("journalctl", "-u", unit, "-n", "200", "--no-pager", "-o", "short-iso")
			e = err
			result = manager.M{"log": string(out)}
		case "restart":
			var state manager.State
			state, e = m.Load()
			if e == nil {
				result, e = m.Apply(state)
			}
		case "backup":
			if len(args) > 1 && args[1] == "list" {
				entries, err := os.ReadDir(filepath.Join(m.Root, "backups"))
				e = err
				ids := []string{}
				for _, entry := range entries {
					if entry.IsDir() {
						if _, err := os.Stat(filepath.Join(m.Root, "backups", entry.Name(), "manifest.json")); err == nil {
							ids = append(ids, entry.Name())
						}
					}
				}
				if os.IsNotExist(e) {
					e = nil
				}
				result = manager.M{"backups": ids}
			} else {
				var id string
				id, e = m.Backup()
				result = manager.M{"backupId": id}
			}
		case "restore":
			if len(args) != 2 {
				return errors.New("usage: fq restore BACKUP_ID")
			}
			result, e = m.Restore(args[1])
		case "core":
			name := "sing-box"
			if len(args) > 2 {
				name = args[2]
			}
			if len(args) < 2 || args[1] != "update" {
				return errors.New("usage: fq core update [sing-box|caddy|cloudflared]")
			}
			result, e = m.InstallCore(name)
		case "install":
			e = m.InstallUnits()
			result = manager.M{"ok": e == nil}
		case "update":
			if len(args) != 2 {
				return errors.New("usage: fq update vX.Y.Z")
			}
			result, e = m.UpdateSelf(args[1])
		case "warp":
			action := "status"
			if len(args) > 1 {
				action = args[1]
			}
			result, e = m.Warp(action)
		case "cert":
			var input struct {
				Domain      string   `json:"domain"`
				Domains     []string `json:"domains"`
				Certificate string   `json:"certificate"`
			}
			if e = manager.Decode(os.Stdin, &input); e != nil {
				return e
			}
			if len(args) != 2 {
				return errors.New("usage: fq cert csr|install")
			}
			if args[1] == "csr" {
				result, e = m.CSR(input.Domain, input.Domains)
			} else if args[1] == "install" {
				result, e = m.InstallCertificate(input.Certificate)
			} else {
				return errors.New("invalid cert operation")
			}
		case "uninstall":
			f := flag.NewFlagSet("uninstall", flag.ContinueOnError)
			yes := f.Bool("yes", false, "confirm removal")
			purge := f.Bool("purge", false, "also remove configuration and backups")
			if e = f.Parse(args[1:]); e != nil {
				return e
			}
			if !*yes {
				return errors.New("fq uninstall --yes [--purge] required")
			}
			for _, unit := range []string{"gungun-sing-box", "gungun-caddy", "gungun-tunnel"} {
				_, _ = m.Command("systemctl", "disable", "--now", unit)
				_ = os.Remove("/etc/systemd/system/" + unit + ".service")
			}
			_, e = m.Command("systemctl", "daemon-reload")
			if e == nil && *purge {
				e = os.RemoveAll(m.Root)
			}
			result = manager.M{"ok": e == nil, "configurationRetained": !*purge}
		default:
			return errors.New("unknown command: " + args[0])
		}
	}
	if e != nil {
		return e
	}
	b, e := marshal(result)
	if e != nil {
		return e
	}
	if !asJSON && args[0] == "log" {
		fmt.Print(result.(manager.M)["log"])
	} else {
		fmt.Println(string(b))
	}
	return nil
}
