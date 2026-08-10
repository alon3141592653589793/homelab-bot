const entry = {
  id: "system-fixes",
  filename: "pi-system-fixes.sh",
  path: "/usr/local/bin/pi-system-fixes.sh",
  description: "One-time Pi system fixes (run with sudo: sudo bash /usr/local/bin/pi-system-fixes.sh). (1) Repairs the recurring logrotate.service failure: creates /var/log/clamav + clamav.log with correct clamav:adm ownership/perm, and injects `missingok` into each ClamAV logrotate stanza so a missing log no longer fails rotation. (2) Enables ssh.service + AdGuardHome.service for auto-start on boot (tries common unit name variants). Idempotent -- safe to rerun. After running, reboot and verify with /boot that both services come back.",
  tags: ["setup", "fix", "logrotate", "clamav", "services", "sudo"],
  code: `#!/bin/bash
# One-time system fixes: logrotate/ClamAV logger + service auto-restart enable.
# Run with sudo:  sudo bash /usr/local/bin/pi-system-fixes.sh
# Idempotent -- safe to run multiple times.

echo "=== 1. logrotate / ClamAV logger ==="
mkdir -p /var/log/clamav
touch /var/log/clamav/clamav.log
if id -u clamav >/dev/null 2>&1; then
  chown -R clamav:adm /var/log/clamav
else
  chown -R root:adm /var/log/clamav
fi
chmod 750 /var/log/clamav
chmod 640 /var/log/clamav/clamav.log

# Add 'missingok' to each ClamAV logrotate stanza (right after the first '{').
# Skips files already patched, so reruns are safe.
for f in /etc/logrotate.d/clamav-daemon /etc/logrotate.d/clamav-freshclam /etc/logrotate.d/clamav; do
  [ -f "$f" ] || continue
  grep -q 'missingok' "$f" && continue
  awk '{print} !d && /[{]/ {print "    missingok"; d=1}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
echo "  -> ClamAV log dir + missingok applied."

echo "=== 2. Enable sshd + AdGuardHome on boot ==="
systemctl enable ssh.service 2>/dev/null || true
systemctl enable sshd.service 2>/dev/null || true
systemctl enable AdGuardHome.service 2>/dev/null || true
systemctl enable adguardhome.service 2>/dev/null || true

echo "=== 3. Status ==="
for s in ssh.service AdGuardHome.service; do
  printf "  %-18s enabled=%-8s active=%s\\n" "$s" \\
    "$(systemctl is-enabled "$s" 2>/dev/null || echo n/a)" \\
    "$(systemctl is-active "$s" 2>/dev/null || echo n/a)"
done
echo "Done."
echo "If AdGuardHome shows 'disabled', its unit may be named differently or not"
echo "installed -- run: systemctl list-unit-files | grep -i adguard"
echo "Then reboot and use the /boot Discord command to confirm both services came back."
`,
};

export default entry;