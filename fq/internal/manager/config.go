package manager

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
)

type M = map[string]any

func SingBoxConfig(s State, root string) M {
	inbounds := []any{}
	rules := []any{}
	seenVlessWS := false
	for _, v := range s.Services {
		if v.Protocol == "vless-ws" && seenVlessWS { continue }
		if v.Protocol == "vless-ws" { seenVlessWS = true }
		typ := v.Protocol
		if typ == "vless-ws" || typ == "vless-reality" { typ = "vless" }
		in := M{"type": typ, "tag": v.ID, "listen": "::", "listen_port": v.Port}
		tls := M{"enabled": true, "certificate_path": filepath.Join(root, "cert.pem"), "key_path": filepath.Join(root, "key.pem")}
		switch v.Protocol {
		case "hysteria2":
			in["users"] = []any{M{"password": v.Password}}
			in["tls"] = tls
		case "tuic":
			in["users"] = []any{M{"uuid": v.UUID, "password": v.Password}}
			in["congestion_control"] = "bbr"
			tls["alpn"] = []string{"h3"}
			in["tls"] = tls
		case "anytls":
			in["users"] = []any{M{"password": v.Password}}
			in["tls"] = tls
		case "snell":
			in["version"] = 6
			in["psk"] = v.Password
			in["mode"] = "default"
		case "vless-ws":
			in["users"] = []any{M{"uuid": v.UUID}}
			in["transport"] = M{"type": "ws", "path": v.Path}
			// Keep TLS on the single shared listener. Argo and CDN both terminate
			// the client-side TLS at their edge and use HTTPS to this origin.
			in["tls"] = tls
		case "vless-reality":
			in["users"] = []any{M{"uuid": v.UUID, "flow": "xtls-rprx-vision"}}
			in["tls"] = M{"enabled": true, "server_name": v.RealityServer, "reality": M{"enabled": true, "handshake": M{"server": v.RealityServer, "server_port": v.RealityPort}, "private_key": s.RealityPrivateKey, "short_id": []string{s.RealityShortID}}}
		}
		inbounds = append(inbounds, in)
		if v.Egress == "WARP" { rules = append(rules, M{"inbound": []string{v.ID}, "action": "route", "outbound": "warp"}) }
	}
	return M{"log": M{"level": "info", "timestamp": true}, "inbounds": inbounds, "outbounds": []any{M{"type": "direct", "tag": "direct"}, M{"type": "socks", "tag": "warp", "server": "127.0.0.1", "server_port": 40000, "version": "5"}}, "route": M{"rules": rules, "final": "direct"}}
}
const camouflageHTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>Welcome</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;box-sizing:border-box;font:16px system-ui;background:#f4f7fb;color:#182230}main{max-width:680px;padding:48px;border-radius:20px;background:white;border:1px solid #e4eaf2}h1{font-size:42px;color:#172b45}p{line-height:1.7;color:#617187}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:30px}.cards section{padding:18px;border:1px solid #e8edf4;border-radius:12px}@media(prefers-color-scheme:dark){body{background:#111827;color:#e6edf5}main{background:#1d2939;border-color:#34445a}h1{color:#e6edf5}p{color:#a9b8ca}.cards section{border-color:#3a4b61}}</style></head><body><main><small>A QUIET CORNER OF THE WEB</small><h1>Welcome.</h1><p>This is a small place for notes, useful links, and things worth keeping. Thanks for stopping by.</p><div class=\"cards\"><section><b>About</b><p>A little background and a few details about this space.</p></section><section><b>Updates</b><p>Occasional notes and recent changes.</p></section><section><b>Resources</b><p>A collection of useful references.</p></section></div></main></body></html>"

func staticSiteRoute(domain string) M {
	return M{
		"match": []any{M{"host": []string{domain}}},
		"handle": []any{M{"handler": "static_response", "status_code": 200, "body": camouflageHTML, "headers": M{"Content-Type": []string{"text/html; charset=utf-8"}}}},
		"terminal": true,
	}
}

func CaddyConfig(s State, root string) M {
	servers := M{}
	if s.Camouflage != nil {
		name := fmt.Sprintf("port_%d", s.Camouflage.Port)
		servers[name] = M{
			"listen": []string{fmt.Sprintf("127.0.0.1:%d", s.Camouflage.Port)},
			"routes": []any{staticSiteRoute(s.Camouflage.Domain)},
			"automatic_https": M{"disable": true},
		}
	}
	for _, w := range s.Websites {
		name := fmt.Sprintf("port_%d", w.Port)
		server, ok := servers[name].(M)
		if !ok {
			server = M{"listen": []string{fmt.Sprintf(":%d", w.Port)}, "routes": []any{}, "automatic_https": M{"disable": true}}
			if w.Access == "argo" {
				server["listen"] = []string{fmt.Sprintf("127.0.0.1:%d", w.Port)}
			} else {
				server["tls_connection_policies"] = []any{M{}}
			}
			servers[name] = server
		}
		transport := M{"protocol": "http"}
		if w.UpstreamTLS {
			transport["tls"] = M{}
		}
		route := M{"match": []any{M{"host": []string{w.Domain}}}, "handle": []any{M{"handler": "reverse_proxy", "upstreams": []any{M{"dial": net.JoinHostPort(w.Target, strconv.Itoa(w.TargetPort))}}, "transport": transport}}, "terminal": true}
		server["routes"] = append(server["routes"].([]any), route)
	}
	tls := M{"certificates": M{"load_files": []any{M{"certificate": filepath.Join(root, "cert.pem"), "key": filepath.Join(root, "key.pem")}}}}
	apps := M{"http": M{"servers": servers}}
	for _, w := range s.Websites {
		if w.Access != "argo" {
			apps["tls"] = tls
			break
		}
	}
	return M{"admin": M{"disabled": true}, "apps": apps}
}
func Export(s State) M {
	nodes := []any{}
	hostName := s.HostName
	if hostName == "" {
		hostName = s.HostID
	}
	for _, v := range s.Services {
		base := M{"id": s.HostID + ":" + v.ID + ":direct", "name": hostName + "-" + v.Protocol + "-" + v.Access, "protocol": v.Protocol, "address": s.PublicAddress, "port": v.PublicPort, "password": v.Password, "uuid": v.UUID, "sni": v.Domain, "tls": v.Protocol != "snell", "insecure": false, "host": v.Domain, "path": v.Path, "publicKey": s.RealityPublicKey, "shortId": s.RealityShortID, "fingerprint": "chrome", "alpn": []string{}, "snellMode": "default", "tagId": "vps-" + s.HostID, "vpsId": s.HostID, "serviceId": v.ID, "source": "vps", "access": v.Access}
		if v.Protocol == "vless-reality" {
			base["sni"] = v.RealityServer
		}
		if v.Protocol == "tuic" {
			base["alpn"] = []string{"h3"}
		}
		if v.Access == "argo" {
			for _, port := range []int{443, 80} {
				copy := M{}
				for k, value := range base {
					copy[k] = value
				}
				copy["id"] = s.HostID + ":" + v.ID + ":argo:" + strconv.Itoa(port)
				copy["name"] = fmt.Sprintf("%s-%s-argo-%d", hostName, v.Protocol, port)
				copy["address"] = v.Domain
				copy["port"] = port
				copy["tls"] = port == 443
				nodes = append(nodes, copy)
			}
		} else {
			if v.Access == "cdn" {
				base["id"] = s.HostID + ":" + v.ID + ":cdn"
				base["address"] = v.Domain
				base["port"] = v.EdgePort
				base["tls"] = v.EdgeScheme != "http"
			}
			nodes = append(nodes, base)
		}
	}
	return M{"schemaVersion": 1, "hostId": s.HostID, "nodes": nodes}
}
