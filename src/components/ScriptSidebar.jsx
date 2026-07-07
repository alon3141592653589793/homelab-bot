import { useState } from "react";
import { cn } from "@/lib/utils";
import { Code2, ChevronRight, Menu, X, Clock } from "lucide-react";

const POLLING_RATES = [
  { label: "profile_scheduler.py", rate: "every 1 min", note: "auto-switches CPU/GPU profile" },
  { label: "ram_logger.py", rate: "every 15 min", note: "logs RAM snapshot" },
  { label: "passive_thermal_monitor", rate: "every 60 sec", note: "checks temp, alerts if hot" },
  { label: "sync_bot_presence", rate: "every 4 min", note: "updates Discord status" },
  { label: "pi-maintenance.sh", rate: "daily 03:00", note: "OS upgrade + reboot" },
];

export default function ScriptSidebar({ scripts, activeId, onSelect, mobileOpen, onMobileClose }) {
  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 z-40 w-72 bg-[#0d1117] border-r border-[#21262d]",
          "flex flex-col transform transition-transform duration-200 ease-in-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-[#21262d]">
          <div className="flex items-center gap-2">
            <Code2 className="w-5 h-5 text-[#58a6ff]" />
            <span className="font-mono text-sm font-semibold text-[#e6edf3]">pi-lab</span>
          </div>
          <button
            onClick={onMobileClose}
            className="lg:hidden text-[#8b949e] hover:text-[#e6edf3]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Script list */}
        <nav className="flex-1 overflow-y-auto py-2">
          {scripts.map((script) => (
            <button
              key={script.id}
              onClick={() => {
                onSelect(script.id);
                onMobileClose();
              }}
              className={cn(
                "w-full text-left px-4 py-3 flex items-center gap-3 transition-colors",
                "hover:bg-[#161b22] group",
                activeId === script.id
                  ? "bg-[#1f6feb]/10 border-r-2 border-[#58a6ff]"
                  : "border-r-2 border-transparent"
              )}
            >
              <span
                className={cn(
                  "font-mono text-sm",
                  activeId === script.id
                    ? "text-[#58a6ff]"
                    : "text-[#e6edf3] group-hover:text-[#e6edf3]"
                )}
              >
                {script.filename}
              </span>
              <ChevronRight
                className={cn(
                  "w-4 h-4 ml-auto transition-opacity",
                  activeId === script.id
                    ? "opacity-100 text-[#58a6ff]"
                    : "opacity-0 group-hover:opacity-50 text-[#8b949e]"
                )}
              />
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-[#21262d]">
          {/* Polling rates */}
          <div className="px-4 py-3 border-b border-[#21262d]">
            <div className="flex items-center gap-1.5 text-xs text-[#8b949e] font-mono mb-2">
              <Clock className="w-3 h-3" />
              <span>polling rates</span>
            </div>
            <div className="space-y-1.5">
              {POLLING_RATES.map((p) => (
                <div key={p.label}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#58a6ff] font-mono text-[10px] truncate">{p.label}</span>
                    <span className="text-[#3fb950] font-mono text-[10px] shrink-0">{p.rate}</span>
                  </div>
                  <p className="text-[#484f58] font-mono text-[10px]">{p.note}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-[#8b949e] font-mono">
              <span className="w-2 h-2 rounded-full bg-[#3fb950]"></span>
              {scripts.length} scripts loaded
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}