package manager

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
)

type Service struct {
	ID            string `json:"id"`
	Protocol      string `json:"protocol"`
	Port          int    `json:"port"`
	PublicPort    int    `json:"publicPort"`
	EdgeScheme    string `json:"edgeScheme,omitempty"`
	EdgePort      int    `json:"edgePort"`
	Access        string `json:"access"`
	Egress        string `json:"egress"`
	Domain        string `json:"domain"`
	Password      string `json:"password"`
	UUID          string `json:"uuid"`
	Path          string `json:"path"`
	RealityServer string `json:"realityServer"`
	RealityPort   int    `json:"realityPort"`
}
type Website struct {
	ID          string `json:"id"`
	Domain      string `json:"domain"`
	Target      string `json:"target"`
	TargetPort  int    `json:"targetPort"`
	UpstreamTLS bool   `json:"upstreamTLS"`
	Access      string `json:"access"`
	Port        int    `json:"port"`
	PublicPort  int    `json:"publicPort"`
	EdgePort    int    `json:"edgePort"`
}
type Certificate struct {
	NotAfter string   `json:"notAfter"`
	Domain   string   `json:"domain"`
	Domains  []string `json:"domains"`
}
type State struct {
	SchemaVersion     int          `json:"schemaVersion"`
	HostID            string       `json:"hostId"`
	HostName          string       `json:"hostName,omitempty"`
	Kind              string       `json:"kind"`
	PublicAddress     string       `json:"publicAddress"`
	Namespace         string       `json:"namespace"`
	ZoneName          string       `json:"zoneName"`
	Services          []Service    `json:"services"`
	Websites          []Website    `json:"websites"`
	DisableTunnel     bool         `json:"disableTunnel,omitempty"`
	TunnelToken       string       `json:"tunnelToken,omitempty"`
	RealityPrivateKey string       `json:"realityPrivateKey,omitempty"`
	RealityPublicKey  string       `json:"realityPublicKey,omitempty"`
	RealityShortID    string       `json:"realityShortId,omitempty"`
	Certificate       *Certificate `json:"certificate,omitempty"`
}

func serviceTransport(protocol string) string {
	switch protocol {
	case "hysteria2", "tuic":
		return "udp"
	default:
		return "tcp"
	}
}

func listenerKey(transport string, port int) string {
	return fmt.Sprintf("%s:%d", transport, port)
}


var validID = regexp.MustCompile(`^[a-z0-9-]{1,50}$`)
var validDomain = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
var validHost = regexp.MustCompile(`^[a-zA-Z0-9.:_-]{1,253}$`)

func ValidPort(p int) bool { return p > 0 && p < 65536 }
func RandomSecret() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func RandomUUID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (s *State) Normalize() error {
	if s.SchemaVersion != 1 {
		return errors.New("unsupported schemaVersion")
	}
	if s.HostID == "" || !validHost.MatchString(s.PublicAddress) {
		return errors.New("hostId and publicAddress required")
	}
	if s.Kind != "public" && s.Kind != "nat" {
		return errors.New("kind must be public or nat")
	}
	used := map[string]string{}
	ids := map[string]bool{}
	for i := range s.Services {
		v := &s.Services[i]
		if !validID.MatchString(v.ID) || ids[v.ID] {
			return errors.New("invalid or duplicate service id")
		}
		ids[v.ID] = true
		switch v.Protocol {
		case "hysteria2", "tuic", "anytls", "snell", "vless-ws", "vless-reality":
		default:
			return errors.New("unsupported protocol")
		}
		if v.Access != "direct" && v.Access != "cdn" && v.Access != "argo" {
			return errors.New("invalid access")
		}
		if v.Access != "direct" && v.Protocol != "vless-ws" {
			return errors.New("only vless-ws supports CDN/Argo")
		}
		if v.Egress != "DIRECT" && v.Egress != "WARP" {
			return errors.New("invalid egress")
		}
		if v.Port == 0 {
			if s.Kind == "nat" {
				return errors.New("NAT requires explicit internal port and public mapping")
			}
			v.Port = allocate(used, serviceTransport(v.Protocol))
		}
		if !ValidPort(v.Port) {
			return errors.New("invalid listen port")
		}
		listenKey := listenerKey(serviceTransport(v.Protocol), v.Port)
		if used[listenKey] != "" {
			sharedVlessWS := v.Protocol == "vless-ws" && strings.HasPrefix(used[listenKey], "vless-ws:")
			if !sharedVlessWS { return fmt.Errorf("listen port collision: %s", listenKey) }
		} else {
			used[listenKey] = "vless-ws:" + v.ID
		}
		if v.Protocol == "vless-ws" {
			for j := 0; j < i; j++ {
				previous := &s.Services[j]
				if previous.Protocol == "vless-ws" && previous.Port != v.Port {
					return errors.New("VLESS + WS access modes must share one internal listener port")
				}
			}
		}
		if v.Access != "argo" {
			if v.PublicPort == 0 {
				if s.Kind == "nat" {
					return errors.New("NAT requires public mapped port")
				}
				v.PublicPort = v.Port
			}
			if !ValidPort(v.PublicPort) {
				return errors.New("invalid public port")
			}
		}
		if v.EdgeScheme == "" { v.EdgeScheme = "https" }
		if v.EdgeScheme != "http" && v.EdgeScheme != "https" {
			return errors.New("invalid Cloudflare edge scheme")
		}
		if v.EdgePort == 0 {
			if v.EdgeScheme == "http" { v.EdgePort = 80 } else { v.EdgePort = 443 }
		}
		if v.Access == "cdn" {
			allowed := []int{443, 2053, 2083, 2087, 2096, 8443}
			if v.EdgeScheme == "http" { allowed = []int{80, 8080, 8880, 2052, 2082, 2086, 2095} }
			valid := false
			for _, candidate := range allowed { if candidate == v.EdgePort { valid = true; break } }
			if !valid { return fmt.Errorf("unsupported Cloudflare %s Edge port: %d", strings.ToUpper(v.EdgeScheme), v.EdgePort) }
		}
		if v.Domain != "" && !validDomain.MatchString(v.Domain) {
			return errors.New("invalid domain")
		}
		if v.Access != "direct" && v.Domain == "" {
			return errors.New("domain required for CDN/Argo")
		}
		if v.Password == "" {
			v.Password = RandomSecret()
		}
		if v.Protocol == "snell" && (len(v.Password) < 12 || len(v.Password) > 255) {
			return errors.New("Snell v6 PSK must be 12 to 255 bytes")
		}
		if v.UUID == "" {
			v.UUID = RandomUUID()
		}
		if !regexp.MustCompile(`^[0-9a-fA-F-]{36}$`).MatchString(v.UUID) {
			return errors.New("invalid UUID")
		}
		if v.Path == "" {
			v.Path = "/gungun"
		}
		if !regexp.MustCompile(`^/[a-zA-Z0-9/_-]*$`).MatchString(v.Path) {
			return errors.New("invalid WS path")
		}
		if v.RealityServer == "" {
			v.RealityServer = "www.microsoft.com"
		}
		if !validHost.MatchString(v.RealityServer) {
			return errors.New("invalid Reality server")
		}
		if v.RealityPort == 0 {
			v.RealityPort = 443
		}
		if !ValidPort(v.RealityPort) {
			return errors.New("invalid Reality port")
		}
	}
	domains := map[string]bool{}
	websiteTransports := map[int]bool{}
	for _, w := range s.Websites {
		if !validID.MatchString(w.ID) || ids[w.ID] {
			return errors.New("invalid website id")
		}
		ids[w.ID] = true
		if !validDomain.MatchString(w.Domain) || domains[w.Domain] {
			return errors.New("invalid or duplicate website domain")
		}
		domains[w.Domain] = true
		if !validHost.MatchString(w.Target) || !ValidPort(w.TargetPort) || !ValidPort(w.Port) || !ValidPort(w.PublicPort) {
			return errors.New("invalid website endpoint")
		}
		websiteListenKey := listenerKey("tcp", w.Port)
		if used[websiteListenKey] != "" {
			return errors.New("website/service TCP port collision")
		}
		if w.Access != "direct" && w.Access != "cdn" && w.Access != "argo" {
			return errors.New("invalid website access")
		}
		argo := w.Access == "argo"
		if previous, exists := websiteTransports[w.Port]; exists && previous != argo {
			return errors.New("Argo HTTP and TLS websites require different internal ports")
		}
		websiteTransports[w.Port] = argo
		if w.Access == "cdn" && !httpsPort(w.EdgePort) {
			return errors.New("unsupported website Edge port")
		}
	}
	if s.RealityPrivateKey == "" {
		key, e := ecdh.X25519().GenerateKey(rand.Reader)
		if e != nil {
			return e
		}
		s.RealityPrivateKey = base64.RawURLEncoding.EncodeToString(key.Bytes())
		s.RealityPublicKey = base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
		b := make([]byte, 8)
		if _, e = rand.Read(b); e != nil {
			return e
		}
		s.RealityShortID = hex.EncodeToString(b)
	}
	return nil
}
func allocate(used map[string]string, transport string) int {
	for p := 20000; p < 60000; p++ {
		if used[listenerKey(transport, p)] != "" {
			continue
		}
		if transport == "udp" {
			packet, err := net.ListenPacket("udp", fmt.Sprintf(":%d", p))
			if err != nil {
				continue
			}
			_ = packet.Close()
			return p
		}
		listener, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
		if err != nil {
			continue
		}
		_ = listener.Close()
		return p
	}
	return 0
}
func httpsPort(p int) bool {
	for _, v := range []int{443, 2053, 2083, 2087, 2096, 8443} {
		if p == v {
			return true
		}
	}
	return false
}
