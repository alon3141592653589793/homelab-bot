import { useState } from "react";
import { Menu, Layers, Check } from "lucide-react";
import ScriptSidebar from "@/components/ScriptSidebar";
import CodeViewer from "@/components/CodeViewer";
import scripts from "@/lib/scriptsData";
import { buildBulkDeployCommand } from "@/lib/bulkDeploy";

export default function Lab() {
  const [activeId, setActiveId] = useState(scripts[0]?.id || null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bulkCopied, setBulkCopied] = useState(false);

  const activeScript = scripts.find((s) => s.id === activeId);

  const handleBulkDeploy = async () => {
    const cmd = buildBulkDeployCommand();
    await navigator.clipboard.writeText(cmd);
    setBulkCopied(true);
    setTimeout(() => setBulkCopied(false), 2500);
  };

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
        <button
          onClick={handleBulkDeploy}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono transition-all border ${
            bulkCopied
              ? "bg-[#3fb950]/10 border-[#3fb950] text-[#3fb950]"
              : "bg-[#21262d] border-[#30363d] text-[#c9d1d9] hover:border-[#58a6ff] hover:text-[#e6edf3]"
          }`}
        >
          {bulkCopied ? <Check className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
          {bulkCopied ? "Copied! Paste in Pi terminal" : "Copy bulk deploy cmd"}
        </button>
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