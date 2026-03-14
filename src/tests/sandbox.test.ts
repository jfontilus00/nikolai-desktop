// ── Sandbox Safety Tests ────────────────────────────────────────────────────
//
// Tests for path validation and workspace escape prevention.
//

import { describe, it, expect } from "vitest";

// Helper function (same logic as agentic.ts)
const isAbsPath = (path: string): boolean => {
  return (
    /^[a-zA-Z]:\//.test(path) ||
    path.startsWith("/") ||
    path.startsWith("//")
  );
};

describe("Path Safety", () => {
  describe("isAbsPath", () => {
    it("should detect Windows absolute paths", () => {
      expect(isAbsPath("C:/Windows/System32")).toBe(true);
      expect(isAbsPath("c:/users/test")).toBe(true);
    });

    it("should detect Unix absolute paths", () => {
      expect(isAbsPath("/etc/passwd")).toBe(true);
      expect(isAbsPath("/home/user/file.txt")).toBe(true);
    });

    it("should detect UNC network paths", () => {
      expect(isAbsPath("//server/share")).toBe(true);
      expect(isAbsPath("//?/C:/Windows")).toBe(true);
    });

    it("should allow relative paths", () => {
      expect(isAbsPath("src/App.tsx")).toBe(false);
      expect(isAbsPath("./config.json")).toBe(false);
      expect(isAbsPath("components/Button.tsx")).toBe(false);
    });

    it("should allow parent directory traversal (relative)", () => {
      expect(isAbsPath("../parent/file.txt")).toBe(false);
      expect(isAbsPath("../../grandparent/file.txt")).toBe(false);
    });
  });

  describe("Path Traversal Detection", () => {
    it("should detect simple traversal", () => {
      const path = "../etc/passwd";
      expect(path.includes("..")).toBe(true);
    });

    it("should detect deep traversal", () => {
      const path = "../../../../../../etc/passwd";
      expect(path.includes("..")).toBe(true);
    });

    it("should detect mixed separators", () => {
      const path = "..\\..\\../etc/passwd";
      expect(path.includes("..")).toBe(true);
    });

    it("should allow single dots (current dir)", () => {
      const path = "./src/App.tsx";
      // Single dot is OK, only ".." is dangerous
      expect(path.includes("..")).toBe(false);
    });
  });

  describe("Workspace Root Validation", () => {
    const normalizeWinPath = (p: string): string => {
      return p.replace(/\\/g, "/");
    };

    const toRelUnderRoot = (
      absPath: string,
      absRoot: string
    ): string | null => {
      const root = normalizeWinPath(absRoot).replace(/\/+$/, "");
      const path = normalizeWinPath(absPath);

      const rootLower = root.toLowerCase();
      const pathLower = path.toLowerCase();

      if (pathLower === rootLower) return "";
      if (pathLower.startsWith(rootLower + "/")) {
        return path.slice(root.length + 1);
      }
      return null;
    };

    it("should return relative path for files under root", () => {
      const root = "C:/Projects/MyApp";
      const filePath = "C:/Projects/MyApp/src/App.tsx";

      const rel = toRelUnderRoot(filePath, root);
      expect(rel).toBe("src/App.tsx");
    });

    it("should return null for files outside root", () => {
      const root = "C:/Projects/MyApp";
      const filePath = "C:/Projects/OtherApp/src/App.tsx";

      const rel = toRelUnderRoot(filePath, root);
      expect(rel).toBeNull();
    });

    it("should handle Windows extended-length paths", () => {
      const root = "\\\\?\\C:/Projects/MyApp";
      const filePath = "\\\\?\\C:/Projects/MyApp/src/App.tsx";

      const rel = toRelUnderRoot(filePath, root);
      expect(rel).toBe("src/App.tsx");
    });

    it("should handle case-insensitive comparison", () => {
      const root = "C:/Projects/MyApp";
      const filePath = "c:/projects/myapp/src/App.tsx";

      const rel = toRelUnderRoot(filePath, root);
      expect(rel).toBe("src/App.tsx");
    });
  });
});

describe("Tool Name Validation", () => {
  const ALLOWED_TOOLS = [
    "fs.read_file",
    "fs.write_file",
    "fs.list_directory",
    "fs.search_files",
    "fs.edit_file",
    "fs.create_directory",
    "fs.delete_file",
    "fs.copy_file",
    "fs.move_file",
    "fs.rename_file",
    "semantic.find",
    "memory.add_fact",
    "hub.refresh",
    "hub.status",
  ];

  const isToolAllowed = (toolName: string): boolean => {
    return ALLOWED_TOOLS.some((allowed) => allowed === toolName);
  };

  it("should allow filesystem tools", () => {
    expect(isToolAllowed("fs.read_file")).toBe(true);
    expect(isToolAllowed("fs.write_file")).toBe(true);
    expect(isToolAllowed("fs.list_directory")).toBe(true);
  });

  it("should block system tools", () => {
    expect(isToolAllowed("system.shell")).toBe(false);
    expect(isToolAllowed("system.exec")).toBe(false);
    expect(isToolAllowed("os.command")).toBe(false);
  });

  it("should block network tools", () => {
    expect(isToolAllowed("http.get")).toBe(false);
    expect(isToolAllowed("http.post")).toBe(false);
    expect(isToolAllowed("network.request")).toBe(false);
  });

  it("should block database tools", () => {
    expect(isToolAllowed("database.query")).toBe(false);
    expect(isToolAllowed("sql.execute")).toBe(false);
  });

  it("should block tools with similar names but different namespace", () => {
    expect(isToolAllowed("evil.read_file")).toBe(false);
    expect(isToolAllowed("fs.read_file_evil")).toBe(false);
  });
});
