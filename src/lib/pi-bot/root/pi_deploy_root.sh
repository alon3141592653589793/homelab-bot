#!/bin/bash
# Root installer for /sync. Run via the sudoers rule (NOPASSWD) from pi_deploy.py.
# Args: <repo-root> <list-file>
# list-file lines: "<src>\t<dst>"  (dst = absolute path, or @crontab)
# Installs ONLY the listed files: copy + chmod + chown, validate sudoers
# fragments BEFORE copying (a bad file can't lock you out), reload
# systemd/udev, apply crontab. Backs up existing targets. Does NOT reboot
# (pi_deploy.py reboots after).
set -e
ROOT="$1"
LIST="$2"
[ -d "$ROOT" ] && [ -f "$LIST" ] || { echo "FAILURE: usage: pi_deploy_root <repo-root> <list-file>"; exit 1; }

BK="/home/alon/secure-pi-bot/.deploy_backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"

NEED_SYSTEMD=0
NEED_UDEV=0
NEED_SUDOERS=0
INSTALLED=0

while IFS=$'\t' read -r src dst || [ -n "$src" ]; do
  [ -z "$src" ] && continue
  srcpath="$ROOT/$src"
  if [ ! -f "$srcpath" ]; then
    echo "SKIP: source missing: $src"
    continue
  fi

  # @crontab -> apply as alon's crontab (crontab(1) requires a trailing
  # newline before EOF; normalize via a temp file so the source is untouched)
  if [ "$dst" = "@crontab" ]; then
    cp "$srcpath" "$BK/crontab.bak"
    tmp="$(mktemp)"
    cat "$srcpath" > "$tmp"
    [ -z "$(tail -c1 "$tmp")" ] || printf '\n' >> "$tmp"
    sudo -u alon crontab "$tmp"
    rm -f "$tmp"
    echo "+ $src -> @crontab (applied)"
    INSTALLED=$((INSTALLED + 1))
    continue
  fi

  # validate sudoers fragment BEFORE copying (a bad file can lock you out)
  case "$dst" in
    /etc/sudoers.d/*)
      visudo -cf "$srcpath" >/dev/null || { echo "FAILURE: sudoers syntax error in $src"; exit 1; }
      ;;
  esac

  # backup existing target
  [ -f "$dst" ] && cp "$dst" "$BK/$(echo "$dst" | tr '/' '_')" 2>/dev/null || true

  mkdir -p "$(dirname "$dst")"
  cp "$srcpath" "$dst"
  chown root:root "$dst"
  case "$dst" in
    /usr/local/bin/*)                chmod 755 "$dst" ;;
    /etc/sudoers.d/*)                chmod 440 "$dst"; NEED_SUDOERS=1 ;;
    /etc/systemd/system/*.service)   NEED_SYSTEMD=1 ;;
    /etc/udev/rules.d/*)             NEED_UDEV=1 ;;
  esac
  h=$(sha256sum "$dst" | cut -c1-12)
  echo "+ $src -> $dst  hash=$h"
  INSTALLED=$((INSTALLED + 1))
done < "$LIST"

# global sudoers syntax check only if a sudoers file was installed
if [ "$NEED_SUDOERS" = "1" ]; then
  visudo -c >/dev/null || { echo "FAILURE: global sudoers syntax error"; exit 1; }
fi

[ "$NEED_SYSTEMD" = "1" ] && systemctl daemon-reload
if [ "$NEED_UDEV" = "1" ]; then
  udevadm control --reload-rules
  udevadm trigger 2>/dev/null || true
fi

echo "Installed $INSTALLED root file(s). Backup: $BK"