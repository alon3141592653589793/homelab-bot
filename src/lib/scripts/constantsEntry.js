const entry = {
  id: "constants",
  filename: "constants.py",
  path: "~/secure-pi-bot/scripts/constants.py",
  description: "Shared constants imported by main.py and params.py so a value (e.g. the thermal alert threshold) lives in ONE place and can't drift between scripts.",
  tags: ["constants", "shared"],
  code: `# Shared constants for secure-pi-bot scripts. Import this instead of
# hardcoding the same value in multiple places so they can't drift apart.
ALERT_THRESHOLD = 70.0  # core temp (C) that triggers a Discord thermal warning
`,
};

export default entry;