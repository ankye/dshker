#!/usr/bin/env bash
# Install the standalone dshkerd binary from an exact official GitHub Release.
# This script deliberately does not configure a service, pair a device, or
# enable autostart. Those choices belong to explicit dshkerd commands.
set -euo pipefail

repository='ankye/dshker'
version=''
[[ -n "${HOME:-}" ]] || { echo 'install-dshkerd: HOME is required' >&2; exit 1; }
install_dir="${DSHKERD_INSTALL_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'EOF'
Install standalone dshkerd from an exact GitHub Release.

Usage:
  install-dshkerd.sh --version X.Y.Z [--install-dir DIR]

The installer verifies the release archive and the embedded dshkerd manifest
before atomically replacing DIR/dshkerd. It never configures a coordinator,
trust key, pairing, or autostart entry.
EOF
}

while (($# > 0)); do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo 'install-dshkerd: --version requires a value' >&2; exit 2; }
      version="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || { echo 'install-dshkerd: --install-dir requires a value' >&2; exit 2; }
      install_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "install-dshkerd: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo 'install-dshkerd: an explicit stable --version X.Y.Z is required' >&2
  exit 2
}
[[ -n "$install_dir" && "$install_dir" = /* ]] || {
  echo 'install-dshkerd: --install-dir must be an absolute path' >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  echo 'install-dshkerd: curl is required' >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo 'install-dshkerd: tar is required' >&2
  exit 1
}

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target='darwin-arm64' ;;
  Darwin:x86_64) target='darwin-x64' ;;
  Linux:aarch64|Linux:arm64) target='linux-arm64' ;;
  Linux:x86_64) target='linux-x64' ;;
  *)
    echo "install-dshkerd: unsupported platform $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

archive="dshkerd-${version}-${target}.tar.gz"
checksums="dshkerd-${version}-checksums.txt"
base_url="https://github.com/${repository}/releases/download/v${version}"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/dshkerd-install.XXXXXX")"
staged=''
cleanup() {
  rm -rf "$temporary_dir"
  [[ -z "$staged" || ! -e "$staged" ]] || rm -f "$staged"
}
trap cleanup EXIT

download() {
  local asset="$1"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "${temporary_dir}/${asset}" "${base_url}/${asset}"
}

download "$archive"
download "$checksums"
expected_archive_sha256="$(awk -v name="$archive" '$2 == name { print $1; exit }' "${temporary_dir}/${checksums}")"
[[ "$expected_archive_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  echo "install-dshkerd: release checksum does not list ${archive}" >&2
  exit 1
}

if command -v shasum >/dev/null 2>&1; then
  actual_archive_sha256="$(shasum -a 256 "${temporary_dir}/${archive}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual_archive_sha256="$(sha256sum "${temporary_dir}/${archive}" | awk '{print $1}')"
else
  echo 'install-dshkerd: shasum or sha256sum is required' >&2
  exit 1
fi
[[ "$actual_archive_sha256" == "$expected_archive_sha256" ]] || {
  echo "install-dshkerd: checksum mismatch for ${archive}; existing installation was not changed" >&2
  exit 1
}

tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir"
package_dir="${temporary_dir}/dshkerd-${version}-${target}"
binary="${package_dir}/dshkerd"
manifest="${package_dir}/dshkerd-manifest.json"
[[ -f "$binary" && -f "$manifest" && -f "${package_dir}/VERSION" ]] || {
  echo 'install-dshkerd: archive contents are incomplete' >&2
  exit 1
}

manifest_value() {
  sed -nE "s/.*\"$1\":\"([^\"]+)\".*/\1/p" "$manifest"
}
[[ "$(manifest_value version)" == "$version" ]] || { echo 'install-dshkerd: manifest version mismatch' >&2; exit 1; }
[[ "$(manifest_value target)" == "$target" ]] || { echo 'install-dshkerd: manifest target mismatch' >&2; exit 1; }
[[ "$(manifest_value executable)" == 'dshkerd' ]] || { echo 'install-dshkerd: manifest executable mismatch' >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then
  actual_binary_sha256="$(shasum -a 256 "$binary" | awk '{print $1}')"
else
  actual_binary_sha256="$(sha256sum "$binary" | awk '{print $1}')"
fi
[[ "$actual_binary_sha256" == "$(manifest_value sha256)" ]] || {
  echo 'install-dshkerd: binary does not match its embedded manifest' >&2
  exit 1
}

mkdir -p "$install_dir"
staged="${install_dir}/.dshkerd.${version}.${target}.$$"
cp "$binary" "$staged"
chmod 0755 "$staged"
mv -f "$staged" "${install_dir}/dshkerd"
echo "Installed dshkerd ${version} (${target}) to ${install_dir}/dshkerd"
echo 'Next: add that directory to PATH if needed, then run `dshkerd help`.'
