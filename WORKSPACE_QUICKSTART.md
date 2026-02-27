# Workspace Quick Start Guide

## 🚀 Quick Commands

```bash
# Run all checks and start dev server
.\run_workspace_tests.ps1

# Or run manually:
pnpm -s lint              # Lint check
npx tsc --noEmit          # Typecheck  
npx @tauri-apps/cli@1.5.9 dev  # Start app
```

## 📁 What Was Added

### Backend (Rust)
- `src-tauri/src/workspace.rs` - Complete workspace management
- `src-tauri/src/main.rs` - Updated with workspace commands

### Frontend (TypeScript/React)
- `src/lib/workspaceClient.ts` - Type-safe API client
- `src/components/WorkspacePanel.tsx` - Full UI component

## 🎯 Key Features

### Single File Operations
- ✅ Set workspace root
- ✅ Browse directories
- ✅ Read/write files (with automatic backup)
- ✅ Create folders and files

### Batch Operations
- ✅ Apply multiple file changes at once
- ✅ Full backup before batch apply
- ✅ Rollback by ID or latest batch
- ✅ JSON-based batch definition

### Security
- ✅ Path sanitization (blocks `..`, absolute paths)
- ✅ Workspace isolation
- ✅ Append-only manifest log
- ✅ Timestamped backups

## 📊 Backup Structure

```
your-workspace/
└── .nikolai_backups/
    ├── manifest.jsonl           # Operation log
    ├── file.txt.123456789.bak  # Individual backups
    └── batches/
        └── <timestamp>/         # Batch directories
            ├── *.bak            # Original files
            └── batch.json       # Metadata
```

## 🧪 Testing Checklist

### Backend
- [ ] Choose workspace root via dialog
- [ ] Navigate folders (Up button works)
- [ ] Create new folder
- [ ] Create new file
- [ ] Edit existing file
- [ ] Apply changes (creates backup)
- [ ] Check `.nikolai_backups/` exists

### Batch Operations
- [ ] Paste valid JSON in batch textarea
- [ ] See preview of files
- [ ] Apply batch (creates batch directory)
- [ ] Rollback latest batch
- [ ] Rollback by specific ID
- [ ] Verify files restored/deleted correctly

### Edge Cases
- [ ] Try path with `..` (should be blocked)
- [ ] Try absolute path (should be blocked)
- [ ] Empty file creation
- [ ] Large file editing
- [ ] Special characters in filenames

## 🔍 Troubleshooting

### Lint errors?
```bash
pnpm -s lint --fix
```

### Type errors?
```bash
npx tsc --noEmit --pretty
```

### Tauri build fails?
```bash
cd src-tauri
cargo clean
cd ..
npx @tauri-apps/cli@1.5.9 dev
```

### Workspace panel not showing?
- Check if component is imported in your main app
- Verify Tauri commands are registered in main.rs
- Check browser console for errors

## 📚 Documentation Files

- `WORKSPACE_IMPLEMENTATION_COMPLETE.md` - Detailed implementation docs
- `WORKSPACE_EXECUTION_COMPLETE.txt` - Execution report
- This file - Quick start guide

## 🎨 UI Preview

The WorkspacePanel includes:
- Root selection button
- File browser with Up/Refresh/New buttons
- File editor with diff preview
- Batch JSON input with live validation
- Apply/Rollback buttons
- Status messages and busy indicators

## 💡 Tips

1. **Always backup**: All writes create automatic backups
2. **Batch safety**: Batch operations are fully reversible
3. **Manifest log**: Check `manifest.jsonl` to see all operations
4. **Last batch ID**: Stored in local storage for quick rollback
5. **Path format**: Use forward slashes (`/`) for all paths

## 🆘 Need Help?

1. Check the manifest log: `.nikolai_backups/manifest.jsonl`
2. Inspect batch metadata: `.nikolai_backups/batches/<id>/batch.json`
3. Review backup files before restoring
4. Check browser console for frontend errors
5. Check terminal for Rust compilation errors

---

**Happy coding! 🎉**
