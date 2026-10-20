import {
  Gamepad2, ShieldAlert, Zap, Eye, Sparkles, Monitor,
  ArrowRight, Lightbulb, Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TIER_STYLES = {
  low: "bg-[#3fb950]/10 text-[#3fb950] border-[#3fb950]/30",
  balanced: "bg-[#d29922]/10 text-[#d29922] border-[#d29922]/30",
  warn: "bg-[#f85149]/10 text-[#f85149] border-[#f85149]/30",
  ok: "bg-[#58a6ff]/10 text-[#58a6ff] border-[#58a6ff]/30",
};

/* ---------- Section 1: Client Compatibility ---------- */

const COMPAT_ITEMS = [
  {
    icon: ShieldAlert,
    title: "Offline mode (cracked Java clients)",
    tier: "low",
    tierLabel: "zero cost",
    summary:
      "Set online-mode=false in server.properties. Every cracked Java client (TLauncher, SKlauncher, etc.) joins instantly with no extra software on the Pi.",
    steps: [
      "/mc cracked on  (toggles online-mode=false, restarts the server)",
      "Friend installs any cracked launcher, enters any username, connects to the Java tunnel IP",
    ],
    tradeoff:
      "No Microsoft auth means usernames are not verified. Anyone who knows the IP can join with any name, including yours. Use a whitelist (/whitelist on, /whitelist add <name>) if you want to lock it to friends only.",
  },
  {
    icon: Monitor,
    title: "Eaglercraft (browser client, no install)",
    tier: "balanced",
    tierLabel: "moderate Pi cost",
    summary:
      "Eaglercraft runs Minecraft in a browser over WebSocket, not TCP. It needs a translation layer because the browser cannot speak the raw Minecraft protocol. On Paper above 1.17 the EaglercraftXServer plugin is not maintained as a direct Bukkit plugin, so the supported path is a lightweight Velocity proxy in front of Paper.",
    steps: [
      "Run Velocity (proxy, ~150 MB RAM) with EaglercraftXServer.jar + ViaVersion in its plugins/",
      "Point Velocity's backend at 127.0.0.1:25565 (your Paper server)",
      "Open a WebSocket port (e.g. 8081) through playit.gg for the browser client",
      "Friend opens eaglercraft.com/play, enters wss://<your-tunnel> and joins",
    ],
    tradeoff:
      "Adds a second Java process on the Pi. On a 2 GB Pi this is tight; on a 4+ GB Pi 4 it works if you cut the Paper heap to ~768 MB. If the Pi cannot spare the RAM, the friend can use a cracked launcher (TLauncher) on any PC instead, which needs only offline-mode and zero extra Pi load.",
  },
];

/* ---------- Section 2: Server-side performance ---------- */

const LOW_COMPROMISE = [
  {
    name: "Spark",
    type: "Plugin (profiler)",
    impact: "Zero gameplay change. ~1 MB. Bundled in Paper 1.21+; standalone jar adds web reports.",
    detail:
      "Profiles CPU + memory + TPS and gives a shareable web report. You cannot optimize what you cannot measure. Run /spark profiler to find the real lag source before installing anything else.",
  },
  {
    name: "Purpur (server swap)",
    type: "Server software",
    impact: "Drop-in Paper fork. Same plugins, same world. Extra config knobs (villager lobotomize, etc.).",
    detail:
      "Built on Paper with additional optimizations and config options. /mc setup currently downloads Paper; swapping to Purpur is a one-jar change that keeps all plugins and Geyser working. Biggest free win after config tuning.",
  },
  {
    name: "Config tuning (no plugin)",
    type: "paper-world.yml",
    impact: "Zero plugins. Sane values have no visible gameplay effect.",
    detail:
      "Already partly done (view-distance=4, sim-distance=4, sync-chunk-writes=false). Next: set entity-activation-range animals=16/monsters=24, spawn-limits monsters=50/animals=8. These are the highest-impact free knobs on a Pi.",
  },
  {
    name: "NoChatReports",
    type: "Plugin",
    impact: "Strips chat signing hashes. Small CPU save, privacy win. No gameplay change.",
    detail:
      "Removes the 1.19+ chat-report system overhead. Helpful on offline-mode servers where chat signing is meaningless anyway. Drop the jar in plugins/, restart.",
  },
];

const BALANCED_GAIN = [
  {
    name: "Anti-RedstoneClock",
    type: "Plugin",
    impact: "Breaks malicious/accidental redstone clocks. Big TPS save on shared servers.",
    detail:
      "Detects and stops redstone loops that tick thousands of times per second. Only a tradeoff if someone builds intentional redstone clocks as a feature. Safe for a small friends server.",
  },
  {
    name: "ViewDistanceTweaks",
    type: "Plugin",
    impact: "Dynamically shrinks view distance when TPS drops. Players see less during lag.",
    detail:
      "Automatically adjusts per-player view distance based on server TPS and player count. Smooths out lag spikes instead of a fixed distance. Set a floor of 3 and ceiling of 6 on the Pi.",
  },
  {
    name: "VillagerOptimizer",
    type: "Plugin",
    impact: "Reduces villager AI. Villagers behave less smartly when far from players.",
    detail:
      "Villager AI is one of the heaviest CPU sinks on a Pi. Lobotomizes distant villagers and re-enables them when a player approaches. Also achievable via Purpur's villager-lobotomize config without a plugin.",
  },
  {
    name: "Lower view/sim to 3",
    type: "server.properties",
    impact: "Cuts chunk load + entity tick cost ~25%. Players see 3 chunks instead of 4.",
    detail:
      "Currently at 4. Dropping to 3 is a direct, measurable TPS gain on the Pi. Only matters if players notice the shorter render distance; for a small friends server it's usually fine.",
  },
];

const AVOID = [
  {
    name: "ClearLagg / EntityTrackerFixer",
    type: "Avoid",
    detail:
      "Community optimization guides warn these change vanilla behavior and can permanently strip entity AI (ETF). ClearLag++ is already installed on this server; it's fine for item cleanup but don't add more entity-clearing plugins on top.",
  },
  {
    name: "'Too good to be true' forks",
    type: "Avoid",
    detail:
      "Many downstream Paper forks claim huge gains but introduce instability. Stick to Paper or Purpur. If config tuning isn't enough, the bottleneck is the Pi's single-core CPU, not the software.",
  },
];

/* ---------- Section 3: Client-side mods ---------- */

const CLIENT_MODS = [
  {
    name: "Shaders (Iris / Oculus / OptiFine)",
    status: "Already work",
    detail:
      "Client-side only. The Paper server does not block shader packs. Java players install Iris (Fabric) or OptiFine (Forge), drop a shader pack in, and it renders on their GPU. Zero server changes, zero Pi cost.",
  },
  {
    name: "Sodium + Lithium + FerriteCore (Fabric)",
    status: "Already work",
    detail:
      "The standard client-side performance stack. Sodium rewrites rendering, FerriteCore cuts RAM, ImmediatelyFast speeds up entity rendering. All client-side; the server is unaffected. Players on cracked launchers can use Fabric exactly like official Minecraft.",
  },
  {
    name: "Entity Culling + Dynamic FPS",
    status: "Already work",
    detail:
      "Entity Culling skips rendering of entities behind walls; Dynamic FPS lowers the game's framerate when unfocused. Pure client-side FPS boost. Helpful on the friend's low-end PC.",
  },
  {
    name: "Bedrock players (via Geyser)",
    status: "Different system",
    detail:
      "Bedrock cannot use Java shaders or Fabric mods. Bedrock has its own RTX/resource-pack shader system. This is an inherent cross-play limitation, not a server config issue. No fix needed, just how cross-play works.",
  },
];

function TierBadge({ tier, label }) {
  return (
    <span className={cn(
      "shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase tracking-wide",
      TIER_STYLES[tier]
    )}>
      {label}
    </span>
  );
}

function CompatCard({ item }) {
  const Icon = item.icon;
  return (
    <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-4 py-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon className="w-4 h-4 text-[#58a6ff] shrink-0" />
          <h3 className="font-mono text-sm font-semibold text-[#e6edf3]">{item.title}</h3>
        </div>
        <TierBadge tier={item.tier} label={item.tierLabel} />
      </div>
      <p className="text-[#8b949e] text-xs leading-relaxed">{item.summary}</p>
      <div className="space-y-1">
        {item.steps.map((s, i) => (
          <div key={i} className="flex items-start gap-2">
            <ArrowRight className="w-3 h-3 text-[#3fb950] shrink-0 mt-0.5" />
            <code className="text-[#e6edf3] text-xs font-mono">{s}</code>
          </div>
        ))}
      </div>
      <p className="text-[#d29922]/80 text-[11px] leading-relaxed pt-1 border-t border-[#21262d]">
        <span className="font-mono font-semibold">Tradeoff: </span>{item.tradeoff}
      </p>
    </div>
  );
}

function ModCard({ mod }) {
  return (
    <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-4 py-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-mono text-sm text-[#e6edf3]">{mod.name}</h3>
        <span className="text-[#484f58] font-mono text-[10px] shrink-0">{mod.type}</span>
      </div>
      <p className="text-[#3fb950] text-[11px] font-mono leading-snug">{mod.impact}</p>
      <p className="text-[#8b949e] text-xs leading-relaxed">{mod.detail}</p>
    </div>
  );
}

function ClientModCard({ mod }) {
  const ok = mod.status === "Already work";
  return (
    <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-4 py-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-mono text-sm text-[#e6edf3]">{mod.name}</h3>
        <TierBadge tier={ok ? "ok" : "balanced"} label={mod.status} />
      </div>
      <p className="text-[#8b949e] text-xs leading-relaxed">{mod.detail}</p>
    </div>
  );
}

export default function MinecraftGuide() {
  return (
    <div className="flex-1 overflow-auto bg-[#0d1117]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-5 h-5 text-[#58a6ff]" />
            <h1 className="font-mono text-lg font-semibold text-[#e6edf3]">
              Minecraft Compatibility & Performance
            </h1>
          </div>
          <p className="text-[#8b949e] text-xs font-mono">
            Researched guide for the Paper + Geyser server on the Pi. Compatibility paths, server-side
            optimization tiers, and client-side mod status.
          </p>
        </div>

        {/* Section 1: Compatibility */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-[#f85149]" />
            <h2 className="font-mono text-sm font-semibold text-[#e6edf3]">Client Compatibility</h2>
          </div>
          <div className="grid gap-2.5">
            {COMPAT_ITEMS.map((it) => <CompatCard key={it.title} item={it} />)}
          </div>
        </section>

        {/* Section 2: Server performance */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-[#3fb950]" />
            <h2 className="font-mono text-sm font-semibold text-[#e6edf3]">
              Server-Side Performance
            </h2>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Lightbulb className="w-3.5 h-3.5 text-[#3fb950]" />
              <h3 className="font-mono text-xs font-semibold text-[#3fb950] uppercase tracking-wide">
                Low compromise
              </h3>
            </div>
            <div className="grid gap-2.5">
              {LOW_COMPROMISE.map((m) => <ModCard key={m.name} mod={m} />)}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Zap className="w-3.5 h-3.5 text-[#d29922]" />
              <h3 className="font-mono text-xs font-semibold text-[#d29922] uppercase tracking-wide">
                Balanced gains (optional)
              </h3>
            </div>
            <div className="grid gap-2.5">
              {BALANCED_GAIN.map((m) => <ModCard key={m.name} mod={m} />)}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Ban className="w-3.5 h-3.5 text-[#f85149]" />
              <h3 className="font-mono text-xs font-semibold text-[#f85149] uppercase tracking-wide">
                Avoid
              </h3>
            </div>
            <div className="grid gap-2.5">
              {AVOID.map((m) => <ModCard key={m.name} mod={m} />)}
            </div>
          </div>
        </section>

        {/* Section 3: Client-side mods */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-[#a371f7]" />
            <h2 className="font-mono text-sm font-semibold text-[#e6edf3]">
              Client-Side Mods (shaders + FPS)
            </h2>
          </div>
          <div className="rounded-lg border border-[#21262d] bg-[#161b22] px-4 py-3">
            <div className="flex items-start gap-2">
              <Sparkles className="w-4 h-4 text-[#3fb950] shrink-0 mt-0.5" />
              <p className="text-[#8b949e] text-xs leading-relaxed">
                Shaders and client performance mods run on <span className="text-[#e6edf3] font-mono">each player's own PC</span>,
                not on the Pi. They do not affect server TPS. The Paper server does not block them,
                so they already work for any Java player (cracked or official) who installs them.
              </p>
            </div>
          </div>
          <div className="grid gap-2.5">
            {CLIENT_MODS.map((m) => <ClientModCard key={m.name} mod={m} />)}
          </div>
        </section>
      </div>
    </div>
  );
}