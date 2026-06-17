import { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

export default function CodeViewer({ script }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(script.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = script.code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [script.code]);

  if (!script) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0d1117]">
        <div className="text-center space-y-4">
          <FileCode className="w-16 h-16 text-[#21262d] mx-auto" />
          <p className="text-[#8b949e] font-mono text-sm">
            Select a script from the sidebar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0d1117] overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#21262d] bg-[#0d1117]">
        <div>
          <h1 className="text-[#e6edf3] font-mono text-sm font-semibold">
            {script.filename}
          </h1>
          <p className="text-[#8b949e] text-xs mt-0.5">{script.description}</p>
        </div>
        <button
          onClick={handleCopy}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-mono transition-all",
            "border border-[#30363d]",
            copied
              ? "bg-[#3fb950]/10 border-[#3fb950] text-[#3fb950]"
              : "bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] hover:border-[#58a6ff]"
          )}
        >
          {copied ? (
            <>
              <Check className="w-4 h-4" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" />
              Copy
            </>
          )}
        </button>
      </div>

      {/* Code area */}
      <div className="flex-1 overflow-auto">
        <SyntaxHighlighter
          language="python"
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: "1.5rem",
            background: "#0d1117",
            fontSize: "13px",
            lineHeight: "1.6",
            minHeight: "100%",
          }}
          showLineNumbers
          lineNumberStyle={{
            minWidth: "2.5em",
            paddingRight: "1em",
            color: "#484f58",
            userSelect: "none",
          }}
        >
          {script.code}
        </SyntaxHighlighter>
      </div>

      {/* Tags */}
      {script.tags && script.tags.length > 0 && (
        <div className="px-6 py-3 border-t border-[#21262d] bg-[#0d1117] flex items-center gap-2 flex-wrap">
          {script.tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-xs font-mono rounded-full bg-[#21262d] text-[#8b949e] border border-[#30363d]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}