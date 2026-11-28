package manager

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (m *Manager) CSR(domain string, extra []string) (M, error) {
	if !validDomain.MatchString(domain) {
		return nil, errors.New("invalid certificate domain")
	}
	keyPath := filepath.Join(m.Root, "key.pem")
	var key *ecdsa.PrivateKey
	b, e := os.ReadFile(keyPath)
	if e == nil {
		block, _ := pem.Decode(b)
		if block == nil {
			return nil, errors.New("invalid existing key")
		}
		k, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return nil, e
		}
		var ok bool
		key, ok = k.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("expected ECDSA key")
		}
	} else if os.IsNotExist(e) {
		key, e = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return nil, e
		}
		der, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return nil, e
		}
		if e = AtomicWrite(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
			return nil, e
		}
	} else {
		return nil, e
	}
	names := []string{domain, "*." + domain}
	seen := map[string]bool{domain: true, "*." + domain: true}
	for _, name := range extra {
		// The generated base and wildcard SANs may also occur in extra.
		if seen[name] {
			continue
		}
		if !validDomain.MatchString(name) {
			return nil, errors.New("invalid additional domain")
		}
		// *.domain 已经覆盖恰好一层子域，避免 Let's Encrypt 收到冗余 SAN。
		suffix := "." + domain
		label := strings.TrimSuffix(name, suffix)
		coveredByWildcard := strings.HasSuffix(name, suffix) && label != "" && !strings.Contains(label, ".")
		if coveredByWildcard {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	csr, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "*." + domain}, DNSNames: names}, key)
	if e != nil {
		return nil, e
	}
	return M{"csr": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr}))}, nil
}
func (m *Manager) InstallCertificate(cert string) (M, error) {
	block, _ := pem.Decode([]byte(cert))
	if block == nil {
		return nil, errors.New("invalid certificate PEM")
	}
	parsed, e := x509.ParseCertificate(block.Bytes)
	if e != nil {
		return nil, e
	}
	if parsed.NotAfter.Before(time.Now().Add(time.Hour)) {
		return nil, errors.New("certificate expired or expires too soon")
	}
	keyPEM, e := os.ReadFile(filepath.Join(m.Root, "key.pem"))
	if e != nil {
		return nil, e
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, errors.New("invalid key")
	}
	key, e := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if e != nil {
		return nil, e
	}
	private, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("invalid ECDSA key")
	}
	public, ok := parsed.PublicKey.(*ecdsa.PublicKey)
	if !ok || !private.PublicKey.Equal(public) {
		return nil, errors.New("certificate key mismatch")
	}
	s, e := m.Load()
	if e != nil {
		return nil, e
	}
	domain := s.Namespace + "." + s.ZoneName
	if e = parsed.VerifyHostname("node." + domain); e != nil {
		return nil, e
	}
	backup, e := m.Backup()
	if e != nil {
		return nil, e
	}
	if e = AtomicWrite(filepath.Join(m.Root, "cert.pem"), []byte(cert), 0600); e != nil {
		return nil, e
	}
	s.Certificate = &Certificate{NotAfter: parsed.NotAfter.UTC().Format(time.RFC3339), Domain: domain, Domains: parsed.DNSNames}
	data, e := marshal(s)
	if e != nil {
		return nil, e
	}
	if e = AtomicWrite(filepath.Join(m.Root, "state.json"), data, 0600); e == nil {
		e = m.restart(s)
	}
	if e == nil {
		e = m.Verify(s)
	}
	if e != nil {
		rollback := m.RestoreFiles(backup)
		if rollback == nil {
			old, load := m.Load()
			rollback = load
			if rollback == nil {
				rollback = m.restart(old)
			}
		}
		return nil, errors.Join(e, rollback)
	}
	return M{"ok": true, "notAfter": s.Certificate.NotAfter, "backupId": backup}, nil
}
