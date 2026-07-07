import scripts from "./scriptsData";

// Scripts that are reference-only (no real file path to deploy)
const SKIP_IDS = ["oneshot", "crontab"];

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function buildBulkDeployCommand() {
  const deployable = scripts.filter(
    (s) => s.path && s.path !== null && !SKIP_IDS.includes(s.id)
  );

  const lines = deployable.map((s) => {
    const b64 = toBase64(s.code);
    const needsSudo =
      s.path.startsWith("/usr/") ||
      s.path.startsWith("/etc/") ||
      s.path.startsWith("/opt/");
    const mkdirCmd = `mkdir -p ${s.path.substring(0, s.path.lastIndexOf("/"))}`;
    // Use heredoc to avoid any single-quote breakage in the base64 payload
    const writeCmd = needsSudo
      ? `base64 -d << 'B64EOF' | sudo tee ${s.path} > /dev/null\n${b64}\nB64EOF`
      : `base64 -d << 'B64EOF' > ${s.path}\n${b64}\nB64EOF`;
    return `${mkdirCmd} && \\\n${writeCmd}`;
  });

  return lines.join(" && \\\n");
}