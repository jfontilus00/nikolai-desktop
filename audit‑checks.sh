#!/usr/bin/env bash
# ------------------------------------------------------------
# audit‑checks.sh – quick “run‑all‑the‑audit‑checks” script
# ------------------------------------------------------------
# Prerequisites:
#   • Node ≥ 18, npm, and the repo’s dev dependencies installed
#   • Bash (standard on Linux/macOS, WSL on Windows)
# ------------------------------------------------------------

set -euo pipefail

# Helper to print coloured status lines
info()   { echo -e "\033[1;34m[INFO]\033[0m $*"; }
warn()   { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error()  { echo -e "\033[1;31m[ERROR]\033[0m $*"; }

# ---------- 1. TypeScript compilation ----------
info "Running npm run build …"
if npm run build > build.log 2>&1; then
  info "✅ TypeScript compiled without fatal errors."
  compiled=true
else
  warn "⚠️ Build finished with errors – see build.log"
  compiled=false
fi

# ---------- 2. Export of McpTool ----------
info "Checking McpTool export …"
if grep -q "export type McpTool" src/lib/mcp.ts; then
  info "✅ McpTool is exported."
  mcp_exported=true
else
  warn "❌ McpTool not exported."
  mcp_exported=false
fi

# ---------- 3. planText usage before assignment ----------
info "Scanning for planText usage before assignment …"
if grep -R "planText" src/lib/agentic.ts | grep -q "parsePlan"; then
  warn "❌ planText may be used before assignment."
  plantext_bug=true
else
  info "✅ No obvious pre‑assignment usage detected."
  plantext_bug=false
fi

# ---------- 4. AgentRunState includes “interrupted” ----------
info "Verifying AgentRunState definition …"
if grep -R "type AgentRunState" -n src/lib/agentic.ts | grep -q "interrupted"; then
  info "✅ \"interrupted\" is present."
  interrupted_present=true
else
  warn "❌ \"interrupted\" missing."
  interrupted_present=false
fi

# ---------- 5. SpeechRecognition type definitions ----------
info "Looking for @types/dom-speech-recognition in package.json …"
if grep -q "\"@types/dom-speech-recognition\"" package.json; then
  info "✅ Types are declared."
  speech_types=true
else
  warn "❌ Types missing – run: npm i -D @types/dom-speech-recognition"
  speech_types=false
fi

# ---------- 6. Orphaned ConversationLoop ----------
info "Searching for imports of ConversationLoop …"
if grep -R "ConversationLoop" src | grep -v -q "src/lib/voice/ConversationLoop.ts"; then
  info "✅ ConversationLoop is imported elsewhere."
  loop_wired=true
else
  warn "❌ ConversationLoop appears only in testLoop.ts."
  loop_wired=false
fi

# ---------- 7. Empty catch blocks (auto‑speak) ----------
info "Detecting empty catch statements …"
if grep -R "catch { }" src | grep -q -e ".tsx" -e ".ts" -e ".js"; then
  warn "❌ Empty catch blocks found."
  empty_catch=true
else
  info "✅ No empty catch blocks."
  empty_catch=false
fi

# ---------- 8. Summary JSON ----------
report=$(cat <<EOF
{
  "typescriptCompiled": $compiled,
  "mcpToolExported": $mcp_exported,
  "planTextPreassigned": $plantext_bug,
  "interruptedInAgentRunState": $interrupted_present,
  "speechRecognitionTypes": $speech_types,
  "conversationLoopWired": $loop_wired,
  "emptyCatchBlocks": $empty_catch
}
EOF
)

echo "$report" > diagnostic-report.json
info "Diagnostic report written to diagnostic‑report.json"

# ---------- 9. Human‑readable summary ----------
echo -e "\n=== QUICK SUMMARY ==="
printf "✔ TypeScript build          : %s\n" "$( $compiled && echo "OK" || echo "FAIL")"
printf "✔ McpTool export            : %s\n" "$( $mcp_exported && echo "OK" || echo "FAIL")"
printf "✔ planText assignment        : %s\n" "$( $plantext_bug && echo "FAIL" || echo "OK")"
printf "✔ AgentRunState \"interrupted\" : %s\n" "$( $interrupted_present && echo "OK" || echo "FAIL")"
printf "✔ SpeechRecognition types   : %s\n" "$( $speech_types && echo "OK" || echo "FAIL")"
printf "✔ ConversationLoop wired     : %s\n" "$( $loop_wired && echo "OK" || echo "FAIL")"
printf "✔ Empty catch blocks         : %s\n" "$( $empty_catch && echo "FAIL" || echo "OK")"
echo -e "=====================\n"

# ------------------------------------------------------------
# End of script
# ------------------------------------------------------------