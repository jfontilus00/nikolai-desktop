\# Nikolai Desktop – Agent Architecture Guard



This document defines the architectural rules and modification policy for this repository.



Any AI coding assistant (Qwen CLI, Claude CLI, Codex, etc.) MUST follow this document when analyzing or modifying the project.



Violating these rules may break the agentic architecture or introduce security vulnerabilities.



------------------------------------------------



\# 1 PROJECT OVERVIEW



Nikolai Desktop is an agentic AI desktop application built with:



Frontend

React + TypeScript



Backend

Tauri (Rust)



Core Capabilities

\- Agent orchestration

\- MCP tool execution

\- Workspace filesystem sandbox

\- Tool execution pipeline

\- Memory and semantic indexing



Critical system components:



Agent Orchestrator

src/lib/agentic.ts



MCP Client (TypeScript)

src/lib/mcp.ts



MCP Server (Rust)

src-tauri/src/mcp.rs



Workspace Filesystem

src-tauri/src/workspace.rs



Tool Parsing

src/lib/toolCmd.ts



Application Entry

src/App.tsx



------------------------------------------------



\# 2 AI MODIFICATION POLICY



AI tools working on this repository MUST follow these rules:



DO NOT

\- perform large refactors

\- change architecture layers

\- modify multiple subsystems in a single patch

\- rewrite core files without explicit instruction



ALWAYS

\- implement minimal targeted fixes

\- modify only files related to the requested improvement

\- preserve existing architecture

\- explain the impact of each change



Patch policy:



ONE FIX PER PATCH.



Each patch must include:



1 problem description

2 modified files

3 code changes

4 expected improvement



------------------------------------------------



\# 3 AGENT ARCHITECTURE



Agent execution flow:



User Request

&nbsp;   ↓

shouldUseAgentic()

&nbsp;   ↓

agenticStreamChat()

&nbsp;   ↓

Planner LLM

&nbsp;   ↓

Plan JSON parsing

&nbsp;   ↓

Tool name resolution

&nbsp;   ↓

Argument normalization

&nbsp;   ↓

Tool execution

&nbsp;   ↓

Result appended to conversation

&nbsp;   ↓

Loop until completion or step limit



This architecture MUST NOT be rewritten.



------------------------------------------------



\# 4 MCP TOOL EXECUTION PIPELINE



Tool execution lifecycle:



LLM Output

&nbsp;   ↓

parsePlan()

&nbsp;   ↓

resolveToolName()

&nbsp;   ↓

normalizeToolArgs()

&nbsp;   ↓

runTool()

&nbsp;   ↓

semanticExecutor()

&nbsp;   ↓

batchingExecutor()

&nbsp;   ↓

mcpCallTool()

&nbsp;   ↓

Rust MCP layer

&nbsp;   ↓

MCP server



Security validation must exist at these layers:



Agent layer

Tool argument validation

Filesystem validation

Rust MCP layer validation



------------------------------------------------



\# 5 SECURITY REQUIREMENTS



The following security rules MUST always be enforced.



Filesystem sandbox:



All file operations must remain inside workspace root.



Path validation must prevent:



\- ../ traversal

\- symlink escape

\- access outside workspace



Tool invocation safety:



\- tool arguments must be validated

\- tool names must be verified

\- unknown tools must be rejected



Tool filtering:



Tool access must use an allowlist model.



Blocklist filtering is not acceptable for production.



------------------------------------------------



\# 6 PATCH PRIORITY ROADMAP



All improvements must follow this order.



PRIORITY 1 – SECURITY



1 JSON Schema validation in MCP layer



File

src-tauri/src/mcp.rs



Function

mcp\_call\_tool()



Goal

Validate tool arguments before forwarding to MCP server.





2 Symlink protection in workspace filesystem



File

src-tauri/src/workspace.rs



Function

sanitize\_rel()



Goal

Use canonical path resolution to prevent workspace escape.





3 Tool allowlist



File

src/lib/agentic.ts



Replace blocklist filtering with explicit allowed tool list.





------------------------------------------------



PRIORITY 2 – RELIABILITY



4 Agent state persistence



File

src/lib/agentic.ts



Persist agent steps and conversation state to allow recovery after crash.





5 Retry logic for LLM failures



File

src/lib/agentic.ts



Add retry with exponential backoff for ollamaChat() failures.





6 Circuit breaker adjustment



File

src/lib/agentic.ts



Increase threshold and allow reset on success.





------------------------------------------------



PRIORITY 3 – AGENT QUALITY



7 Context management improvement



Replace naive context trimming with summarized tool results.





8 Robust JSON parsing



Implement JSON repair or tolerant parsing for partial LLM responses.





------------------------------------------------



PRIORITY 4 – PERFORMANCE



9 Cache tool catalog



Avoid rebuilding tool catalog on every agent step.





10 Batch tool logs



Avoid synchronous localStorage writes for each tool execution.



------------------------------------------------



\# 7 FAILURE PREVENTION RULES



The agent system must avoid these failure modes:



infinite agent loops

tool hallucination loops

filesystem corruption

partial tool execution

loss of agent state



All patches should reduce one of these risks.



------------------------------------------------



\# 8 CODE CHANGE GUIDELINES



When implementing a patch:



Modify only necessary files.



Avoid changes to:



agent execution loop

tool protocol

MCP communication protocol



Unless explicitly instructed.



------------------------------------------------



\# 9 AI REVIEW REQUIREMENT



Before applying changes, AI tools should:



1 inspect relevant files

2 confirm problem location

3 propose minimal patch

4 explain expected gain



------------------------------------------------



\# 10 ARCHITECTURAL GOAL



Target architecture maturity score:



8.5 / 10



Current architecture has strong foundations but requires:



\- security hardening

\- validation layers

\- better failure recovery



AI tools should focus on these improvements without redesigning the system.



------------------------------------------------

