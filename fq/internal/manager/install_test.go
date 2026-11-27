package manager

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestSingBoxAssetNameSelectsMuslOnAlpine(t *testing.T) {
	if got := SingBoxAssetName("amd64", true); got != "sing-box-1.14.4-linux-amd64-musl.tar.gz" {
		t.Fatalf("amd64 Alpine asset = %q", got)
	}
	if got := SingBoxAssetName("arm64", true); got != "sing-box-1.14.4-linux-arm64-musl.tar.gz" {
		t.Fatalf("arm64 Alpine asset = %q", got)
	}
	if got := SingBoxAssetName("amd64", false); got != "sing-box-1.14.4-linux-amd64.tar.gz" {
		t.Fatalf("glibc asset = %q", got)
	}
}

func TestExtractExecutableFileStreamsTarGzip(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "sing-box.tar.gz")
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	tarWriter := tar.NewWriter(gz)
	if err := tarWriter.WriteHeader(&tar.Header{Name: "sing-box-1.14.4/README.md", Mode: 0644, Size: 4, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write([]byte("read")); err != nil {
		t.Fatal(err)
	}
	want := []byte("binary-content")
	if err := tarWriter.WriteHeader(&tar.Header{Name: "sing-box-1.14.4/sing-box", Mode: 0755, Size: int64(len(want)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(want); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath, compressed.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}

	target := filepath.Join(dir, ".sing-box.new")
	if err := ExtractExecutableFile(archivePath, "sing-box.tar.gz", "sing-box", target); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("extracted bytes = %q, want %q", got, want)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("mode = %o, want 755", info.Mode().Perm())
	}
}

func TestExtractExecutableFileDoesNotReplaceTargetWhenMissing(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "empty.tar.gz")
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	tarWriter := tar.NewWriter(gz)
	if err := tarWriter.WriteHeader(&tar.Header{Name: "other-file", Mode: 0644, Size: 1, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tarWriter.Write([]byte("x"))
	_ = tarWriter.Close()
	_ = gz.Close()
	if err := os.WriteFile(archivePath, compressed.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "sing-box.new")
	err := ExtractExecutableFile(archivePath, "empty.tar.gz", "sing-box", target)
	if err == nil {
		t.Fatal("expected missing binary error")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatalf("target should not be created, stat error = %v", statErr)
	}
}
