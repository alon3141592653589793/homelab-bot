const entry = {
  id: "deploy-manifest",
  filename: "deploy_manifest.txt",
  path: "~/secure-pi-bot/deploy_manifest.txt",
  description: "List of files /sync installs OUTSIDE ~/secure-pi-bot (root-owned scripts, crontab, config fragments). One '<src> <target>' per line; target = absolute path (installed via pi_deploy_root.sh) or @crontab (applied as alon's crontab). Only files that CHANGED in the pull are reinstalled (idempotent + safe). pi_deploy.py reads this after the git pull; pi_deploy_root.sh performs the root installs. Lines starting with # are comments.",
  tags: ["deploy", "manifest", "config", "root", "reference"],
  code: `# deploy_manifest.txt -- files /sync installs OUTSIDE ~/secure-pi-bot.
# One entry per line:  <repo-relative-source> <target>
#   target = absolute path  -> root-owned, installed via pi_deploy_root.sh
#   target = @crontab        -> applied as alon's crontab
# Lines starting with # are ignored. Only files that CHANGED in the pull are
# reinstalled (idempotent + safe). Source paths are relative to the repo root
# (~/secure-pi-bot). Edit this in the app, commit, push, then /sync.
#
# Root-owned scripts (keep their copies in the repo under scripts/):
scripts/pi-maintenance.sh    /usr/local/bin/pi-maintenance.sh
scripts/pi-audit.sh          /usr/local/bin/pi-audit.sh
scripts/led_ctl.py           /usr/local/bin/led_ctl
scripts/pi_deploy_root.sh    /usr/local/bin/pi_deploy_root
scripts/crontab.txt          @crontab
#
# Config fragments -- UNCOMMENT after you add the file to the repo:
# scripts/pi-leds.service     /etc/systemd/system/pi-leds.service
# scripts/49-pi-bot.rules      /etc/polkit-1/rules.d/49-pi-bot.rules
# scripts/99-cpufreq.rules     /etc/udev/rules.d/99-cpufreq.rules
# scripts/pi-leds.sudoers      /etc/sudoers.d/pi-leds
# scripts/pi-deploy.sudoers    /etc/sudoers.d/pi-deploy
`,
};

export default entry;