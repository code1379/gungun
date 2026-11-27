package manager

import (
	"archive/tar"
	"bytes"
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

var HTTPClient = &http.Client{Timeout: 10 * time.Minute}

const maxReleaseAssetSize int64 = 150 << 20
const maxExtractedBinarySize int64 = 200 << 20

type Asset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
}

func releaseAsset(repo, tag, name string) (Asset, error) {
	req, err := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/tags/"+tag, nil)
	if err != nil {
		return Asset{}, err
	}
	req.Header.Set("User-Agent", "gungun-fq")
	response, err := HTTPClient.Do(req)
	if err != nil {
		return Asset{}, fmt.Errorf("release metadata request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Asset{}, fmt.Errorf("release metadata HTTP %d", response.StatusCode)
	}
	var release struct {
		Assets []Asset `json:"assets"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&release); err != nil {
		return Asset{}, fmt.Errorf("decode release metadata: %w", err)
	}
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		if !strings.HasPrefix(asset.Digest, "sha256:") {
			return Asset{}, errors.New("release asset SHA256 digest missing")
		}
		if !strings.HasPrefix(asset.URL, "https://github.com/"+repo+"/releases/download/") {
			return Asset{}, errors.New("invalid release URL")
		}
		return asset, nil
	}
	return Asset{}, fmt.Errorf("release asset not found: %s", name)
}

// DownloadRelease remains for small self-update binaries. Large component
// archives use DownloadReleaseToFile to avoid keeping compressed and expanded
// copies in memory at the same time.
func DownloadRelease(repo, tag, name string) ([]byte, error) {
	asset, err := releaseAsset(repo, tag, name)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("GET", asset.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "gungun-fq")
	response, err := HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("asset HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxReleaseAssetSize {
		return nil, fmt.Errorf("release asset exceeds %d bytes", maxReleaseAssetSize)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxReleaseAssetSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxReleaseAssetSize {
		return nil, fmt.Errorf("release asset exceeds %d bytes", maxReleaseAssetSize)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != strings.TrimPrefix(asset.Digest, "sha256:") {
		return nil, errors.New("asset SHA256 mismatch")
	}
	return data, nil
}

// DownloadReleaseToFile streams an asset to disk while calculating SHA256.
// The destination is replaced only after the complete file is verified.
func DownloadReleaseToFile(repo, tag, name, destination string) error {
	asset, err := releaseAsset(repo, tag, name)
	if err != nil {
		return err
	}
	request, err := http.NewRequest("GET", asset.URL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "gungun-fq")
	response, err := HTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", name, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("asset HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxReleaseAssetSize {
		return fmt.Errorf("release asset exceeds %d bytes", maxReleaseAssetSize)
	}
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".gungun-download-*")
	if err != nil {
		return err
	}
	tempPath := file.Name()
	defer os.Remove(tempPath)

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maxReleaseAssetSize+1))
	if copyErr != nil {
		_ = file.Close()
		return fmt.Errorf("stream release asset: %w", copyErr)
	}
	if written > maxReleaseAssetSize {
		_ = file.Close()
		return fmt.Errorf("release asset exceeds %d bytes", maxReleaseAssetSize)
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != strings.TrimPrefix(asset.Digest, "sha256:") {
		return errors.New("asset SHA256 mismatch")
	}
	if err = os.Rename(tempPath, destination); err != nil {
		return fmt.Errorf("commit downloaded asset: %w", err)
	}
	return nil
}

// ExtractExecutable is retained for callers that already have a small archive
// in memory. Component installation uses ExtractExecutableFile instead.
func ExtractExecutable(data []byte, archive, target string) ([]byte, error) {
	if !strings.HasSuffix(archive, ".gz") {
		return data, nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	if !strings.HasSuffix(archive, ".tar.gz") {
		return io.ReadAll(io.LimitReader(gz, maxExtractedBinarySize+1))
	}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil, errors.New("binary missing in archive")
		}
		if err != nil {
			return nil, err
		}
		if filepath.Base(header.Name) == target && (header.Typeflag == tar.TypeReg || header.Typeflag == tar.TypeRegA) {
			if header.Size > maxExtractedBinarySize {
				return nil, fmt.Errorf("executable exceeds %d bytes", maxExtractedBinarySize)
			}
			return io.ReadAll(io.LimitReader(reader, maxExtractedBinarySize+1))
		}
	}
}

// ExtractExecutableFile extracts or copies an executable directly to a staged
// file in the target directory. Memory use stays bounded while large binaries
// are decompressed.
func ExtractExecutableFile(archivePath, archiveName, target, targetPath string) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}
	staged, err := os.CreateTemp(filepath.Dir(targetPath), ".gungun-core-*")
	if err != nil {
		return err
	}
	stagedPath := staged.Name()
	defer os.Remove(stagedPath)

	var source io.Reader
	var archiveFile *os.File
	var gzipReader *gzip.Reader
	archiveFile, err = os.Open(archivePath)
	if err != nil {
		_ = staged.Close()
		return err
	}
	defer archiveFile.Close()

	if strings.HasSuffix(archiveName, ".gz") {
		gzipReader, err = gzip.NewReader(archiveFile)
		if err != nil {
			_ = staged.Close()
			return fmt.Errorf("open gzip archive: %w", err)
		}
		defer gzipReader.Close()
		source = gzipReader
	} else {
		source = archiveFile
	}

	var written int64
	if strings.HasSuffix(archiveName, ".tar.gz") {
		reader := tar.NewReader(source)
		found := false
		for {
			header, nextErr := reader.Next()
			if nextErr == io.EOF {
				break
			}
			if nextErr != nil {
				_ = staged.Close()
				return fmt.Errorf("read tar archive: %w", nextErr)
			}
			if filepath.Base(header.Name) != target || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) {
				continue
			}
			if header.Size > maxExtractedBinarySize {
				_ = staged.Close()
				return fmt.Errorf("executable exceeds %d bytes", maxExtractedBinarySize)
			}
			written, err = io.Copy(staged, io.LimitReader(reader, maxExtractedBinarySize+1))
			if err != nil {
				_ = staged.Close()
				return fmt.Errorf("extract %s: %w", target, err)
			}
			if written > maxExtractedBinarySize {
				_ = staged.Close()
				return fmt.Errorf("executable exceeds %d bytes", maxExtractedBinarySize)
			}
			found = true
			break
		}
		if !found {
			_ = staged.Close()
			return fmt.Errorf("binary missing in archive: %s", target)
		}
	} else {
		written, err = io.Copy(staged, io.LimitReader(source, maxExtractedBinarySize+1))
		if err != nil {
			_ = staged.Close()
			return fmt.Errorf("extract executable: %w", err)
		}
		if written > maxExtractedBinarySize {
			_ = staged.Close()
			return fmt.Errorf("executable exceeds %d bytes", maxExtractedBinarySize)
		}
	}
	if written == 0 {
		_ = staged.Close()
		return errors.New("downloaded executable is empty")
	}
	if err = staged.Chmod(0755); err != nil {
		_ = staged.Close()
		return err
	}
	if err = staged.Sync(); err != nil {
		_ = staged.Close()
		return err
	}
	if err = staged.Close(); err != nil {
		return err
	}
	if err = os.Rename(stagedPath, targetPath); err != nil {
		return fmt.Errorf("stage executable: %w", err)
	}
	return nil
}

func copyFile(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err = io.Copy(output, input); err != nil {
		_ = output.Close()
		_ = os.Remove(destination)
		return err
	}
	if err = output.Sync(); err != nil {
		_ = output.Close()
		_ = os.Remove(destination)
		return err
	}
	if err = output.Close(); err != nil {
		_ = os.Remove(destination)
		return err
	}
	return os.Chmod(destination, mode)
}

func IsAlpine() bool {
	_, err := os.Stat("/etc/alpine-release")
	return err == nil
}

func SingBoxAssetName(arch string, alpine bool) string {
	flavor := ""
	if alpine {
		flavor = "-musl"
	}
	return "sing-box-1.14.4-linux-" + arch + flavor + ".tar.gz"
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
		asset = SingBoxAssetName(arch, IsAlpine())
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

	archive, err := os.CreateTemp("", "gungun-"+name+"-*.archive")
	if err != nil {
		return nil, err
	}
	archivePath := archive.Name()
	if err = archive.Close(); err != nil {
		_ = os.Remove(archivePath)
		return nil, err
	}
	_ = os.Remove(archivePath)
	defer os.Remove(archivePath)

	if err = DownloadReleaseToFile(repo, tag, asset, archivePath); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(m.Bin, 0755); err != nil {
		return nil, err
	}
	path := filepath.Join(m.Bin, name)
	stagedPath := filepath.Join(m.Bin, "."+name+".new")
	_ = os.Remove(stagedPath)
	if err = ExtractExecutableFile(archivePath, asset, name, stagedPath); err != nil {
		return nil, err
	}

	backupPath := path + ".previous"
	_ = os.Remove(backupPath)
	previous := false
	if _, statErr := os.Stat(path); statErr == nil {
		if err = os.Link(path, backupPath); err != nil {
			if err = copyFile(path, backupPath, 0755); err != nil {
				_ = os.Remove(stagedPath)
				return nil, fmt.Errorf("preserve previous %s binary: %w", name, err)
			}
		}
		previous = true
	} else if !errors.Is(statErr, os.ErrNotExist) {
		_ = os.Remove(stagedPath)
		return nil, statErr
	}
	if err = os.Rename(stagedPath, path); err != nil {
		_ = os.Remove(stagedPath)
		if previous {
			_ = os.Remove(backupPath)
		}
		return nil, fmt.Errorf("replace %s binary: %w", name, err)
	}

	versionArg := "version"
	if name == "cloudflared" {
		versionArg = "--version"
	}
	rollback := func(cause error) (M, error) {
		var undo error
		if previous {
			undo = os.Rename(backupPath, path)
		} else {
			undo = os.Remove(path)
			if errors.Is(undo, os.ErrNotExist) {
				undo = nil
			}
		}
		return nil, errors.Join(cause, undo)
	}

	out, err := m.Command(path, versionArg)
	if err != nil {
		return rollback(err)
	}
	state, err := m.Load()
	if err != nil {
		return rollback(err)
	}
	unit := ""
	switch name {
	case "sing-box":
		if len(state.Services) > 0 {
			unit = "gungun-sing-box"
			if _, err = m.Command(path, "check", "-c", filepath.Join(m.Root, "sing-box.json")); err != nil {
				return rollback(err)
			}
		}
	case "caddy":
		if len(state.Websites) > 0 {
			unit = "gungun-caddy"
			if _, err = m.Command(path, "validate", "--config", filepath.Join(m.Root, "caddy.json")); err != nil {
				return rollback(err)
			}
		}
	case "cloudflared":
		if state.TunnelToken != "" {
			unit = "gungun-tunnel"
		}
	}
	if unit != "" {
		if _, err = m.ServiceAction(unit, "restart"); err == nil {
			err = m.Verify(state)
		}
		if err != nil {
			_, undo := rollback(err)
			_, restart := m.ServiceAction(unit, "restart")
			return nil, errors.Join(undo, restart)
		}
	}
	if previous {
		_ = os.Remove(backupPath)
	}
	return M{"ok": true, "core": name, "version": strings.TrimSpace(string(out)), "asset": asset}, nil
}

func (m *Manager) InstallUnits() error { return m.InstallServices() }

func (m *Manager) UpdateSelf(version string) (M, error) {
	if !strings.HasPrefix(version, "v") || strings.ContainsAny(version, "/\ ") {
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
