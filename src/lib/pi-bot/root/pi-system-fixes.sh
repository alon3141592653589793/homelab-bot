#!/bin/bash
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
  printf "  %-18s enabled=%-8s active=%s\n" "$s" \
    "$(systemctl is-enabled "$s" 2>/dev/null || echo n/a)" \
    "$(systemctl is-active "$s" 2>/dev/null || echo n/a)"
done

echo "=== 4. Guard rc.local ondemand governor writes ==="
# rc.local hardcodes an ondemand up_threshold write. Under the powersave
# governor that path doesn't exist -> rc-local.service crashes (exit 2).
# Wrap the bare line in an existence check so it only runs when ondemand is
# active. Idempotent: skips if already guarded.
if [ -f /etc/rc.local ]; then
  if grep -qE 'echo [0-9]+ > /sys/devices/system/cpu/cpufreq/ondemand/up_threshold' /etc/rc.local \
     && ! grep -qF 'if [ -d "/sys/devices/system/cpu/cpufreq/ondemand"' /etc/rc.local; then
    cp /etc/rc.local "/etc/rc.local.bak.$(date +%s)"
    sed -i -E 's|^echo [0-9]+ > /sys/devices/system/cpu/cpufreq/ondemand/up_threshold.*|if [ -d "/sys/devices/system/cpu/cpufreq/ondemand" ]; then\n  echo 95 > /sys/devices/system/cpu/cpufreq/ondemand/up_threshold\nfi|' /etc/rc.local
    echo "  -> guarded the ondemand up_threshold line (backup saved)."
  else
    echo "  -> rc.local already guarded or no bare ondemand line."
  fi
  systemctl restart rc-local.service 2>/dev/null && echo "  -> rc-local.service restarted." || true
else
  echo "  -> /etc/rc.local not present; nothing to patch."
fi

echo "Done."
echo "Then reboot and use the /boot Discord command to confirm both services came back."