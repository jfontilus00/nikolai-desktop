# Nikolai Voice System Implementation Plan

This document defines the **safe, staged implementation plan** for adding seamless voice conversation to Nikolai. The goal is to introduce voice capabilities **without destabilizing the existing agent architecture**.

This plan must be followed strictly. Do not skip phases.

---

# Objectives

Create a **seamless conversational voice loop**:

listen → detect silence → agent reasoning + tools → speak response → listen again

The system should feel like a continuous conversation rather than a push‑to‑talk assistant.

---

# Current System (Baseline)

Before implementing voice, the system already includes:

- Agent loop
- Tool execution engine
- Tool reflection
- LLM request queue
- LLM timeout guards
- Agent step timeout
- SQLite persistence
- Semantic memory
- TTS client
- Ollama health monitor

These components **must remain untouched unless explicitly required.**

Voice must be built **on top of the existing architecture**, not replace it.

---

# Core Principle

Voice is a **control layer**, not a reasoning layer.

Architecture becomes:

UI
 ↓
ConversationLoop
 ↓
Agent Loop
 ↓
Tools
 ↓
LLM Queue
 ↓
Ollama

---

# Implementation Strategy

Voice must be implemented in **three phases** to minimize risk.

---

# Phase 1 — Conversation Engine (SAFE)

Goal: Implement the voice turn engine **without modifying UI**.

Create:

src/lib/voice/ConversationLoop.ts
src/lib/voice/agentAdapter.ts

This phase introduces:

- Voice Activity Detection (VAD)
- Speech Recognition
- Agent streaming adapter
- Turn state machine

States:

idle
listening
user_speaking
processing
agent_thinking
agent_speaking
interrupted

Responsibilities of ConversationLoop:

- Manage the conversation turn cycle
- Detect silence using VAD
- Trigger agent execution
- Stream tokens to UI
- Feed sentences to TTS
- Resume listening after response

Important constraints:

Do NOT modify:

agentic.ts
ollamaStream.ts
ollamaChat.ts

Use an adapter instead.

Adapter file:

src/lib/voice/agentAdapter.ts

Responsibilities:

- Wrap agenticStreamChat
- Convert tokens into AgentEvents

AgentEvents:

- token
- tool_start
- tool_done
- final
- error


Success Criteria Phase 1:

- Agent runs correctly from the voice loop
- Tokens stream correctly
- Tools execute correctly
- No UI changes required

---

# Phase 2 — UI Integration

Goal: Connect the voice engine to the UI.

Implement:

src/components/VoicePanel.tsx

Features:

- Voice activation button
- Orb indicator
- Phase display
- Interim transcript
- Tool activity display

Phase indicator states:

Idle
Listening
User speaking
Processing
Thinking
Speaking
Interrupted

Important rule:

The UI must **only observe state**.

It must NOT:

- control the agent
- control tool execution
- manage audio processing

The ConversationLoop remains the controller.

Success Criteria Phase 2:

- Voice conversation works end‑to‑end
- Tokens appear in chat
- Tools display correctly

---

# Phase 3 — Advanced Features

Add optional improvements.

Features:

Barge‑in

User can interrupt agent speech.

Implementation:

Spacebar shortcut

When triggered:

- stop TTS
- abort agent
- return to listening


Sentence Streaming TTS

Instead of waiting for full responses:

agent tokens → detect sentence → speak immediately

This reduces perceived latency by ~2 seconds.


Tool Narration

When agent calls tools:

"Using terminal..."
"Searching files..."


Ollama Watchdog (Rust)

File:

src-tauri/src/ollama_watchdog.rs

Purpose:

Detect Ollama failures and restart automatically.

Flow:

health check → restart Ollama → notify frontend

---

# Safety Rules

Rule 1

Never modify core agent logic while implementing voice.

Rule 2

Voice components must live in:

src/lib/voice/

Rule 3

The voice system must fail gracefully.

If STT fails:

Return to idle state.

Rule 4

All long‑running operations must support cancellation.

Use AbortController.

Rule 5

Agent execution must still respect:

- LLM request queue
- tool budget
- agent timeout

Voice cannot bypass these protections.

---

# STT Implementation

Initial implementation uses:

Web Speech API

window.SpeechRecognition

Reason:

- zero install
- works inside Tauri

Future upgrade path:

Whisper.cpp
FasterWhisper

---

# VAD Configuration

Recommended values:

VAD_THRESHOLD = 0.018
VAD_SILENCE_MS = 1100

Purpose:

Detect when the user stops speaking.

---

# TTS Pipeline

Speech must use markdown‑cleaned text.

Remove:

- markdown symbols
- code blocks
- links
- bullet markers

Example:

Input:

"**Here is the result:**\n```rust code```"

Output speech:

"Here is the result"

---

# Tool Announcements

When tools run, announce briefly.

Examples:

"Reading a file"
"Running a command"
"Searching files"

Purpose:

Users understand what the agent is doing.

---

# Stress Testing Requirements

Before enabling voice in production, test:

1. Long conversations
2. Tool chains
3. Large file operations
4. Interruptions
5. LLM queue behavior

Voice must not break:

- agent stability
- tool execution
- database persistence

---

# Git Workflow

Voice must be implemented in a feature branch.

Example:

```

git checkout -b feature/voice-loop

```

After testing:

```

git merge feature/voice-loop

```

---

# Known Risks

SpeechRecognition reliability varies by OS.

Potential issues:

- microphone permissions
- background noise
- browser STT limitations

These are acceptable for the first version.

---

# Success Criteria

The system should feel like:

"Talking to an assistant"

Not:

"Pressing a voice recorder"

The final loop should be:

User speaks
↓
Agent thinks
↓
Agent uses tools
↓
Agent speaks response
↓
Assistant listens again

---

# Final Rule

Do not implement voice until:

- stress testing of current system is complete
- a stable checkpoint exists in Git

Once those conditions are met, begin Phase 1.

---

End of document

