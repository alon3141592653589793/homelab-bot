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
    // Ensure parent directory exists
    const mkdirCmd = `mkdir -p ${s.path.substring(0, s.path.lastIndexOf("/"))}`;
    const writeCmd = needsSudo
      ? `echo '${b64}' | base64 -d | sudo tee ${s.path} > /dev/null`
      : `echo '${b64}' | base64 -d > ${s.path}`;
    return `${mkdirCmd} && ${writeCmd}`;
  });

  return lines.join(" && \\\n");
}