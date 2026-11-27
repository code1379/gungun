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
	for _, v := range s.Services {
		listen := "::"
		if v.Access == "argo" {
			listen = "127.0.0.1"
		}
		typ := v.Protocol
		if typ == "vless-ws" || typ == "vless-reality" {
			typ = "vless"
		}
		in := M{"type": typ, "tag": v.ID, "listen": listen, "listen_port": v.Port}
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
			if v.Access != "argo" {
				in["tls"] = tls
			}
		case "vless-reality":
			in["users"] = []any{M{"uuid": v.UUID, "flow": "xtls-rprx-vision"}}
			in["tls"] = M{"enabled": true, "server_name": v.RealityServer, "reality": M{"enabled": true, "handshake": M{"server": v.RealityServer, "server_port": v.RealityPort}, "private_key": s.RealityPrivateKey, "short_id": []string{s.RealityShortID}}}
		}
		inbounds = append(inbounds, in)
		if v.Egress == "WARP" {
			rules = append(rules, M{"inbound": []string{v.ID}, "action": "route", "outbound": "warp"})
		}
	}
	return M{"log": M{"level": "info", "timestamp": true}, "inbounds": inbounds, "outbounds": []any{M{"type": "direct", "tag": "direct"}, M{"type": "socks", "tag": "warp", "server": "127.0.0.1", "server_port": 40000, "version": "5"}}, "route": M{"rules": rules, "final": "direct"}}
}
func CaddyConfig(s State, root string) M {
	servers := M{}
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
			}
			nodes = append(nodes, base)
		}
	}
	return M{"schemaVersion": 1, "hostId": s.HostID, "nodes": nodes}
}
