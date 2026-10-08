#!/usr/bin/env bash
# Cloud Agent bootstrap for By Your Side.
# Branded Chrome ignores --load-extension. Chrome for Testing still loads the unpacked extension.
# The product launcher only searches the macOS Playwright cache, so this also links the Linux binary there.
set -euo pipefail

NODE_VERSION=22.23.3

# Login shells on a running agent can see an older Node ahead of /usr/local/bin.
# The build pod uses /usr/local/bin, so the required runtime is installed there.
if ! /usr/local/bin/node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 19) ? 0 : 1)' >/dev/null 2>&1; then
  tmp=$(mktemp)
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$tmp"
  sudo tar -xJf "$tmp" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "$tmp"
fi
export PATH="/usr/local/bin:${PATH}"
hash -r

cd /workspace
npm ci
# install-deps needs root. The browser itself must land in the ubuntu user's cache;
# sudo would download Chrome for Testing into /root and the launcher would not see it.
sudo DEBIAN_FRONTEND=noninteractive npx playwright install-deps chromium
npx playwright install chromium

chrome=$(find "$HOME/.cache/ms-playwright" -type f -path '*/chrome-linux64/chrome' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
if [[ -z "${chrome}" || ! -x "${chrome}" ]]; then
  echo "Chrome for Testing was not installed" >&2
  exit 1
fi

rev=$(basename "$(dirname "$(dirname "$chrome")")")
dest="$HOME/Library/Caches/ms-playwright/${rev}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS"
mkdir -p "$dest"
ln -sfn "$chrome" "$dest/Google Chrome for Testing"
sudo ln -sfn "$chrome" /usr/local/bin/chrome-for-testing

# The VM's google-chrome command is the desktop browser. Branded Chrome 137+ ignores
# --load-extension, so both launchers use Chrome for Testing and the unpacked build.
write_launcher() {
  local path="$1"
  local extra="$2"
  sudo tee "$path" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
ext=/workspace/extension/dist
if [[ ! -f "\$ext/manifest.json" ]]; then
  echo "缺少 extension/dist。先在仓库根目录运行 npm run build。" >&2
  exit 1
fi
exec /usr/local/bin/chrome-for-testing \\
  --no-sandbox \\
  --disable-dev-shm-usage \\
  --password-store=basic \\
  --no-first-run \\
  --no-default-browser-check \\
  --load-extension="\$ext" \\
  --disable-extensions-except="\$ext" \\
  ${extra}"\$@"
EOF
  sudo chmod 755 "$path"
}

write_launcher /usr/local/bin/bys-chrome ""
# Same flags the desktop session already expects, plus the extension.
write_launcher /usr/local/bin/google-chrome "--test-type --use-gl=angle --use-angle=swiftshader-webgl --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir=/home/ubuntu/.config/bys-chrome --class=google-chrome --window-size=1820,1100 --window-position=50,50 "

npm run build
