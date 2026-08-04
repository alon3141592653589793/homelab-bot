import { useState } from "react";
import { Menu } from "lucide-react";
import ScriptSidebar from "@/components/ScriptSidebar";
import CodeViewer from "@/components/CodeViewer";
import scripts from "@/lib/scriptsData";

export default function Lab() {
  const [activeId, setActiveId] = useState(scripts[0]?.id || null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeScript = scripts.find((s) => s.id === activeId);

  return (
    <div className="h-screen flex bg-[#0d1117] overflow-hidden pt-12">
      {/* Top bar */}
      <div className="fixed top-0 left-0 right-0 z-20 h-12 bg-[#161b22] border-b border-[#21262d] flex items-center justify-between px-4 lg:px-6">
        <button
          onClick={() => setMobileOpen(true)}
          className="lg:hidden p-1.5 rounded-md text-[#8b949e] hover:text-[#e6edf3]"
        >
          <Menu className="w-5 h-5" />
        </button>
        <span className="text-[#484f58] font-mono text-xs hidden lg:block">pi-lab</span>
        <span className="w-5 lg:hidden" />
      </div>

      <ScriptSidebar
        scripts={scripts}
        activeId={activeId}
        onSelect={setActiveId}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <CodeViewer script={activeScript} />
    </div>
  );
}