import { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, FileCode, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

export default function CodeViewer({ script }) {
  const [copied, setCopied] = useState(false);
  const [cmdCopied, setCmdCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(script.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [script.code]);

  const handleCmdCopy = useCallback(async () => {
    const bytes = new TextEncoder().encode(script.code);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    const needsSudo = script.path && (script.path.startsWith('/usr/') || script.path.startsWith('/etc/') || script.path.startsWith('/opt/'));
    // Use heredoc to avoid single-quote breakage in the base64 payload
    const cmd = needsSudo
      ? `base64 -d << 'B64EOF' | sudo tee ${script.path} > /dev/null\n${b64}\nB64EOF`
      : `base64 -d << 'B64EOF' > ${script.path}\n${b64}\nB64EOF`;
    await navigator.clipboard.writeText(cmd);
    setCmdCopied(true);
    setTimeout(() => setCmdCopied(false), 2000);
  }, [script]);

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
      <div className="flex items-start justify-between px-6 py-3 border-b border-[#21262d] bg-[#0d1117] gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-[#e6edf3] font-mono text-sm font-semibold">
              {script.filename}
            </h1>
            {script.path && (
              <span className="text-[#484f58] font-mono text-xs hidden sm:inline">
                {script.path}
              </span>
            )}
          </div>
          <p className="text-[#8b949e] text-xs mt-0.5">{script.description}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Override command button */}
          {script.path && script.path !== null && (
            <button
              onClick={handleCmdCopy}
              title="Copy shell override command (cat > file heredoc)"
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-mono transition-all",
                "border border-[#30363d]",
                cmdCopied
                  ? "bg-[#388bfd]/10 border-[#388bfd] text-[#388bfd]"
                  : "bg-[#21262d] text-[#8b949e] hover:bg-[#30363d] hover:border-[#388bfd] hover:text-[#c9d1d9]"
              )}
            >
              {cmdCopied ? (
                <>
                  <Check className="w-4 h-4" />
                  <span className="hidden sm:inline">Command copied!</span>
                </>
              ) : (
                <>
                  <Terminal className="w-4 h-4" />
                  <span className="hidden sm:inline">Override cmd</span>
                </>
              )}
            </button>
          )}

          {/* Copy code button */}
          <button
            onClick={handleCopy}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-mono transition-all",
              "border border-[#30363d]",
              copied
                ? "bg-[#3fb950]/10 border-[#3fb950] text-[#3fb950]"
                : "bg-[#21262d] text-[#c9d1d9] hover:bg-[#30363d] hover:border-[#58a6ff]"
            )}
          >
            {copied ? (
              <>
                <Check className="w-4 h-4" />
                <span className="hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
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