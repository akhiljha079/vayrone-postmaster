#!/bin/sh
# Builds .deb and .rpm for Linux x64 (and arm64 with ARCH=arm64).
#   sh scripts/package-linux.sh            → dist/vayrone-postmaster_<ver>_amd64.deb, …x86_64.rpm, SHA256SUMS
# Run on Linux (the executable is compiled for the build machine's platform);
# SKIP_BUILD=1 packages an existing release/linux-<arch>.
# Needs nfpm on PATH (https://github.com/goreleaser/nfpm/releases).
set -e
cd "$(dirname "$0")/.."
ARCH=${ARCH:-x64}
[ -n "$SKIP_BUILD" ] || node scripts/build-release.mjs --target "linux-$ARCH" ${RELEASE:+--release}
VERSION=$(cat "release/linux-$ARCH/VERSION")
mkdir -p dist
PKG_ARCH=$([ "$ARCH" = x64 ] && echo amd64 || echo arm64)
# nfpm does not expand variables in file paths: write a resolved copy of the config.
CFG=$(mktemp "${TMPDIR:-/tmp}/nfpm.XXXXXX")
sed -e "s#\${VPM_RELEASE_DIR}#release/linux-$ARCH#g" -e "s#\${VPM_VERSION}#$VERSION#g" -e "s#\${VPM_ARCH}#$PKG_ARCH#g" installer/linux/nfpm.yaml > "$CFG"
for fmt in deb rpm; do
  nfpm package --config "$CFG" --packager "$fmt" --target dist/
done
rm -f "$CFG"
cp installer/linux/install.sh dist/install.sh
(cd dist && sha256sum ./*.deb ./*.rpm install.sh 2>/dev/null > SHA256SUMS || shasum -a 256 ./*.deb ./*.rpm install.sh > SHA256SUMS)
echo "$VERSION" > dist/LATEST
ls -l dist
