// ── JSON Repair Tests ───────────────────────────────────────────────────────
//
// Tests for the JSON parsing functionality in parsePlan().
// Note: parsePlan() only parses VALID JSON, it does NOT repair malformed JSON.
//

import { describe, it, expect } from "vitest";
import { parsePlan } from "../lib/agentic";

describe("JSON Parsing", () => {
  describe("Valid JSON (Fast Path)", () => {
    it("should parse standard JSON", () => {
      const input = JSON.stringify({
        action: "tool",
        name: "fs.read_file",
        args: { path: "README.md" },
      });

      const plan = parsePlan(input);

      expect(plan).not.toBeNull();
      expect(plan?.action).toBe("tool");
      expect(plan?.name).toBe("fs.read_file");
      expect(plan?.args?.path).toBe("README.md");
    });

    it("should parse JSON with nested objects", () => {
      const input = JSON.stringify({
        action: "tool",
        name: "fs.write_file",
        args: {
          path: "src/test.ts",
          content: "console.log('hello')",
        },
      });

      const plan = parsePlan(input);

      expect(plan).not.toBeNull();
      expect(plan?.args?.content).toBe("console.log('hello')");
    });
  });

  describe("JSON Repair Behavior", () => {
    it("should return null for unquoted keys (repair not fully effective)", () => {
      const input = `{ tool: fs.read_file, args: { path: "README.md" } }`;
      const plan = parsePlan(input);

      // repairJsonString attempts to quote unquoted keys but may not handle all cases
      expect(plan).toBeNull();
    });

    it("should parse trailing commas (repaired by repairJsonString)", () => {
      const input = `{ "action": "tool", "name": "fs.read_file", }`;
      const plan = parsePlan(input);

      // repairJsonString removes trailing commas
      expect(plan).not.toBeNull();
      expect(plan?.action).toBe("tool");
    });

    it("should return null for single quotes (repair not fully effective)", () => {
      const input = `{ 'action': 'tool', 'name': 'fs.read_file' }`;
      const plan = parsePlan(input);

      // repairJsonString attempts to convert single quotes but may not handle all cases
      expect(plan).toBeNull();
    });

    it("should return null for mixed quotes (repair not fully effective)", () => {
      const input = `{ 'action': "tool", "name": 'fs.read_file' }`;
      const plan = parsePlan(input);

      expect(plan).toBeNull();
    });

    it("should return null for missing closing brace", () => {
      const input = `{ "action": "tool", "name": "fs.read_file"`;
      const plan = parsePlan(input);

      // Cannot repair incomplete JSON
      expect(plan).toBeNull();
    });

    it("should return null for completely broken JSON", () => {
      const input = `{ invalid json completely broken`;
      const plan = parsePlan(input);

      expect(plan).toBeNull();
    });

    it("should return null for empty string", () => {
      const plan = parsePlan("");
      expect(plan).toBeNull();
    });

    it("should return null for plain text", () => {
      const plan = parsePlan("Hello, this is just text");
      expect(plan).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle whitespace around JSON", () => {
      const input = `  \n  { "action": "tool", "name": "fs.read_file" }  \n  `;
      const plan = parsePlan(input);

      // stripCodeFences trims whitespace before parsing
      expect(plan).not.toBeNull();
      expect(plan?.action).toBe("tool");
    });

    it("should handle unicode in strings", () => {
      const input = `{ "action": "tool", "name": "fs.read_file", "path": "文件.md" }`;
      const plan = parsePlan(input);

      expect(plan).not.toBeNull();
    });
  });
});

describe("Plan Structure Validation", () => {
  it("should return tool action with correct structure", () => {
    const input = `{"action":"tool","name":"fs.read_file","args":{"path":"test.txt"}}`;
    const plan = parsePlan(input);

    expect(plan).toMatchObject({
      action: "tool",
      name: "fs.read_file",
      args: {
        path: "test.txt",
      },
    });
  });

  it("should return final action with content", () => {
    const input = `{"action":"final","content":"Here is the answer"}`;
    const plan = parsePlan(input);

    expect(plan).toMatchObject({
      action: "final",
      content: "Here is the answer",
    });
  });

  it("should NOT include confidence field (not preserved by parsePlan)", () => {
    const input = `{"action":"tool","name":"fs.read_file","confidence":0.9}`;
    const plan = parsePlan(input);

    // parsePlan only extracts action, name, args for tool actions
    // confidence field is NOT preserved
    expect(plan).toBeDefined();
    expect(plan?.action).toBe("tool");
    expect(plan?.confidence).toBeUndefined();
  });

  it("should NOT include reasoning field (not preserved by parsePlan)", () => {
    const input = `{"action":"tool","name":"fs.read_file","reasoning":"Need to check the file"}`;
    const plan = parsePlan(input);

    // parsePlan only extracts action, name, args for tool actions
    // reasoning field is NOT preserved
    expect(plan).toBeDefined();
    expect(plan?.action).toBe("tool");
    expect(plan?.reasoning).toBeUndefined();
  });
});
