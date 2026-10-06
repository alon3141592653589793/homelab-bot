import { AlertTriangle, Wrench, FlaskConical, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

// Severity -> badge color (dark theme palette)
const SEV = {
  broken: "bg-[#f85149]/10 text-[#f85149] border-[#f85149]/30",
  warning: "bg-[#d29922]/10 text-[#d29922] border-[#d29922]/30",
  pending: "bg-[#58a6ff]/10 text-[#58a6ff] border-[#58a6ff]/30",
  untested: "bg-[#a371f7]/10 text-[#a371f7] border-[#a371f7]/30",
};

const KNOWN_ISSUES = [
  {
    title: "Discord /help command broken",
    detail: "The /help command currently does not respond. Routing or handler needs fixing.",
    sev: "broken",
  },
  {
    title: "AI diagnostics fail on API rate limits",
    detail: "Gemini-backed /aidebug and auto-error triggers occasionally fail when the rate limit is hit.",
    sev: "warning",
  },
  {
    title: "System metrics report inaccurate / zeroed data",
    detail: "temp/CPU/RAM readings occasionally come back zero or stale; psutil read path needs review.",
    sev: "warning",
  },
  {
    title: "Intermittent loss of inbound SSH access",
    detail: "SSH becomes unreachable at random intervals; likely network/firewall related.",
    sev: "warning",
  },
  {
    title: "/parameters vs system marker files desync",
    detail: "Reported parameter state can drift from the on-disk marker files that actually drive behavior.",
    sev: "warning",
  },
  {
    title: "VPN_CHANNEL_ID not configured in .env",
    detail: "The VPN Discord channel id is unset, so VPN alerts have no destination channel.",
    sev: "pending",
  },
  {
    title: "GCP service account + secrets pending setup",
    detail: "Google Sheets logging (log_sync, weekly_report, lynis_snapshot) falls back to local SD files until the GCP service account is configured.",
    sev: "pending",
  },
  {
    title: "wg-easy admin-password file permission unverified",
    detail: "The WireGuard admin password file perms need verification; could block VPN management.",
    sev: "pending",
  },
  {
    title: "Minecraft setup needs manual Java 25 upgrade",
    detail: "Paper 26.x requires JDK 25, which is not in RPi OS bookworm; must install Azul Zulu 25 by hand before /mc setup.",
    sev: "pending",
  },
];

const NOT_IMPLEMENTED = [
  {
    title: "Generic URL support for /gofile mirror",
    detail: "Mirror command currently resolves HuggingFace refs; arbitrary direct-download URLs are not yet supported.",
    sev: "pending",
  },
  {
    title: "Automated Gofile health checks + proactive alerts",
    detail: "No scheduled liveness sweep with Discord notification for tracked Gofile links that die between keep-alive runs.",
    sev: "pending",
  },
  {
    title: "Gofile keep-alive persistence hardening",
    detail: "Keep-alive flow works but reliability on free-tier mirrors (token rotation, direct-link mirrors) needs improvement.",
    sev: "warning",
  },
];

const UNTESTED = [
  {
    title: "Gofile guest-token + website-token handshake",
    detail: "Recently refactored free download-resolution flow (POST /accounts + wt from alljs.js). Not yet verified end-to-end on the Pi.",
    sev: "untested",
  },
  {
    title: "LED cron reconciler (Asia/Jerusalem TZ)",
    detail: "Switched to explicit ZoneInfo('Asia/Jerusalem') for the 22:00-10:00 sleep window. Needs on-device confirmation that the window aligns with local wall clock.",
    sev: "untested",
  },
  {
    title: "Minecraft auto-backup change detection",
    detail: "New /mc autobackup + cron (every 6h) skips when region/entity chunks are unchanged and keeps 5 auto versions. Change-detection signature not yet validated against a real world.",
    sev: "untested",
  },
  {
    title: "Manual vs auto backup rotation isolation",
    detail: "Manual backups (mc-*) should never be rotated by the auto flow (mc-auto-*). Edge cases (mixed dirs, concurrent runs) untested.",
    sev: "untested",
  },
];

function Section({ icon: Icon, title, accent, items }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className={cn("w-4 h-4", accent)} />
        <h2 className="font-mono text-sm font-semibold text-[#e6edf3]">{title}</h2>
        <span className="text-[#484f58] font-mono text-xs">({items.length})</span>
      </div>
      <div className="grid gap-2.5">
        {items.map((it) => (
          <div
            key={it.title}
            className="rounded-lg border border-[#21262d] bg-[#161b22] px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-mono text-sm text-[#e6edf3] leading-snug">
                {it.title}
              </h3>
              <span
                className={cn(
                  "shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wide",
                  SEV[it.sev]
                )}
              >
                {it.sev}
              </span>
            </div>
            <p className="text-[#8b949e] text-xs mt-1.5 leading-relaxed">
              {it.detail}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ProjectStatus() {
  const total = KNOWN_ISSUES.length + NOT_IMPLEMENTED.length + UNTESTED.length;
  return (
    <div className="flex-1 overflow-auto bg-[#0d1117]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CircleAlert className="w-5 h-5 text-[#d29922]" />
            <h1 className="font-mono text-lg font-semibold text-[#e6edf3]">
              Project Status
            </h1>
          </div>
          <p className="text-[#8b949e] text-xs font-mono">
            {total} tracked items — known issues, features not fully implemented, and unverified / untested changes.
          </p>
        </div>

        <Section
          icon={AlertTriangle}
          title="Known Issues"
          accent="text-[#f85149]"
          items={KNOWN_ISSUES}
        />
        <Section
          icon={Wrench}
          title="Not Fully Implemented"
          accent="text-[#58a6ff]"
          items={NOT_IMPLEMENTED}
        />
        <Section
          icon={FlaskConical}
          title="Untested / Unverified"
          accent="text-[#a371f7]"
          items={UNTESTED}
        />
      </div>
    </div>
  );
}