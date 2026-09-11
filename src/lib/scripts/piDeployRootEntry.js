const entry = {
  id: "pi-deploy-root",
  filename: "pi_deploy_root.sh",
  path: "/usr/local/bin/pi_deploy_root",
  description: "Root half of the self-deploy (run via the sudoers NOPASSWD rule from pi_deploy.py). Installs root-owned files from the deploy tree (usr/local/bin, etc/systemd/system, etc/sudoers.d, etc/polkit-1/rules.d, etc/udev/rules.d), applies alon's crontab, validates sudoers fragments BEFORE copying (so a bad file can't lock you out), reloads systemd, enables pi-leds, flushes logs, then reboots (unless --no-reboot). The reboot is delayed 3s via nohup so pi_deploy.py can flush its 'Rebooting...' line to Discord before the Pi dies.",
  tags: ["deploy", "root", "sudoers", "reboot", "bash"],
  code: `#!/bin/bash
# Root half of the self-deploy. Run via the sudoers rule (NOPASSWD) from
# pi_deploy.py. Installs root-owned files from the deploy tree, applies
# crontab, reloads systemd, enables services, then reboots (unless --no-reboot).
set -e
D="$1"
[ -d "$D" ] || { echo "FAILURE: deploy dir '$D' missing"; exit 1; }
NO_REBOOT=0
[ "$2" = "--no-reboot" ] && NO_REBOOT=1

# Snapshot the dangerous root configs BEFORE overwriting -> recoverable if it breaks.
BK="/home/alon/secure-pi-bot/.deploy_backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
tar -cf "$BK/sudoers.tar" /etc/sudoers.d 2>/dev/null || true
crontab -u alon -l > "$BK/crontab.alon" 2>/dev/null || true
[ -f /etc/polkit-1/rules.d/49-pi-bot.rules ] && cp /etc/polkit-1/rules.d/49-pi-bot.rules "$BK/" 2>/dev/null || true
[ -f /etc/udev/rules.d/99-cpufreq.rules ] && cp /etc/udev/rules.d/99-cpufreq.rules "$BK/" 2>/dev/null || true
[ -f /etc/systemd/system/pi-leds.service ] && cp /etc/systemd/system/pi-leds.service "$BK/" 2>/dev/null || true
chown -R alon:alon "$BK" 2>/dev/null || true
echo "Backup -> $BK"

# Validate any sudoers fragment BEFORE copying (a bad file can lock you out).
for f in "$D"/etc/sudoers.d/*; do
  [ -f "$f" ] || continue
  visudo -cf "$f" >/dev/null || { echo "FAILURE: sudoers syntax error in $f"; exit 1; }
done

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