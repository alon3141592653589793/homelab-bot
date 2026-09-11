const entry = {
  id: "pi-deploy-root",
  filename: "pi_deploy_root.sh",
  path: "/usr/local/bin/pi_deploy_root",
  description: "Root half of the self-deploy (run via the sudoers NOPASSWD rule from pi_deploy.py). Installs root-owned files from the deploy tree (usr/local/bin, etc/systemd/system, etc/sudoers.d, etc/polkit-1/rules.d, etc/udev/rules.d), applies alon's crontab, validates sudoers fragments BEFORE copying (so a bad file can't lock you out), reloads systemd, enables pi-leds, flushes logs, then reboots (unless --no-reboot). The reboot is delayed 3s via nohup so pi_deploy.py can flush its 'Rebooting...' line to Discord before the Pi dies. Supports --dry-run (validates sudoers, reports the plan, writes nothing) for safe pre-flight testing.",
  tags: ["deploy", "root", "sudoers", "reboot", "bash"],
  code: `#!/bin/bash
# Root half of the self-deploy. Run via the sudoers rule (NOPASSWD) from
# pi_deploy.py. Installs root-owned files from the deploy tree, applies
# crontab, reloads systemd, enables services, then reboots (unless --no-reboot).
set -e
D="$1"
shift
[ -d "$D" ] || { echo "FAILURE: deploy dir '$D' missing"; exit 1; }
NO_REBOOT=0
DRY=0
for a in "$@"; do
  case "$a" in
    --no-reboot) NO_REBOOT=1 ;;
    --dry-run) DRY=1 ;;
  esac
done
[ "$DRY" -eq 1 ] && echo "[DRY-RUN] no files will be written, no reboot."

# Validate any sudoers fragment BEFORE copying (a bad file can lock you out).
for f in "$D"/etc/sudoers.d/*; do
  [ -f "$f" ] || continue
  visudo -cf "$f" >/dev/null || { echo "FAILURE: sudoers syntax error in $f"; exit 1; }
done

if [ "$DRY" -eq 1 ]; then
  echo "Dry-run plan: install /usr/local/bin/*, /etc/{systemd/system,sudoers.d,polkit-1/rules.d,udev/rules.d}/*, crontab; daemon-reload; enable pi-leds; reboot unless --no-reboot."
  echo "[DRY-RUN] OK -- sudoers fragments validated, nothing written."
  exit 0
fi

# usr/local/bin -> /usr/local/bin (chmod 755 on the known executables)
if [ -d "$D/usr/local/bin" ]; then
  cp -r "$D/usr/local/bin/." /usr/local/bin/
  for x in led_ctl pi-maintenance.sh pi-audit.sh pi_deploy_root; do
    [ -f "/usr/local/bin/$x" ] && chmod 755 "/usr/local/bin/$x"
  done
  echo "Installed /usr/local/bin/*"
fi

# etc/* selected subdirs -> /etc/*
for sub in systemd/system sudoers.d polkit-1/rules.d udev/rules.d; do
  if [ -d "$D/etc/$sub" ]; then
    mkdir -p "/etc/$sub"
    cp -r "$D/etc/$sub/." "/etc/$sub/"
    echo "Installed /etc/$sub/*"
  fi
done

# sudoers perms + global syntax check
for f in /etc/sudoers.d/pi-leds /etc/sudoers.d/pi-deploy; do
  [ -f "$f" ] && chmod 440 "$f"
done
visudo -c >/dev/null || { echo "FAILURE: global sudoers syntax error"; exit 1; }

# udev
[ -d "$D/etc/udev/rules.d" ] && { udevadm control --reload-rules; udevadm trigger 2>/dev/null || true; }

# crontab (alon's)
if [ -f "$D/crontab.txt" ]; then
  sudo -u alon crontab "$D/crontab.txt"
  echo "Installed crontab"
fi

# systemd
systemctl daemon-reload
systemctl enable --now pi-leds 2>/dev/null || true

# Flush logs before reboot (best-effort)
sudo -u alon python3 /home/alon/secure-pi-bot/scripts/compress_logs.py >/dev/null 2>&1 || true

if [ "$NO_REBOOT" -eq 1 ]; then
  echo "Deploy applied. Skipping reboot (--no-reboot)."
else
  echo "Deploy applied. Rebooting in 3s..."
  nohup sh -c 'sleep 3; systemctl reboot' >/dev/null 2>&1 &
fi
`,
};

export default entry;