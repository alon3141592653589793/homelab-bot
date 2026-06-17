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
    <div className="h-screen flex bg-[#0d1117] overflow-hidden">
      {/* Mobile menu button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-20 p-2 rounded-md bg-[#21262d] border border-[#30363d] text-[#c9d1d9] hover:text-[#e6edf3]"
      >
        <Menu className="w-5 h-5" />
      </button>

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