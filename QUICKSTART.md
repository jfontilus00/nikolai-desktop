# Nikolai Desktop - Quick Start Guide

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ installed
- pnpm installed (`npm install -g pnpm`)
- Ollama running at `http://192.168.0.79:11436`
- Model `qwen2.5:7b-instruct-q4_K_M` pulled in Ollama

### Installation
```bash
cd C:\Dev\Nikolai-desktop
pnpm install
```

### Development Mode
```bash
pnpm dev
```
- Opens browser at http://localhost:5173
- Hot reload enabled
- Tailwind CSS working

### Build for Production
```bash
pnpm build
```
- Outputs to `dist/` folder
- Minified and optimized

### Tauri Desktop App
```bash
cargo tauri dev    # Development
cargo tauri build  # Production build
```

## 📁 Project Structure

```
Nikolai-desktop/
├── src/
│   ├── components/      # UI components
│   │   ├── ResizableShell.tsx
│   │   ├── ChatHistory.tsx
│   │   ├── ChatCenter.tsx
│   │   └── RightPanel.tsx
│   ├── lib/            # Utilities
│   │   ├── id.ts
│   │   ├── storage.ts
│   │   └── ollamaStream.ts
│   ├── types.ts        # Type definitions
│   ├── App.tsx         # Main app logic
│   ├── main.tsx        # React entry
│   └── index.css       # Tailwind CSS
├── tailwind.config.ts  # Tailwind config
├── vite.config.ts      # Vite config
└── package.json        # Dependencies
```

## 🎯 Key Features

### Chat Interface
- Three-panel resizable layout
- Create, delete, rename chats
- Search chat history
- Streaming responses from Ollama
- Stop button during streaming
- Auto-scroll to latest message

### Persistence
- All state saved to localStorage
- Chats, layout, settings persist
- Automatic save on changes

### Ollama Integration
- Configurable base URL
- Configurable model
- Token-by-token streaming
- Error handling
- Cancel/stop support

## ⚙️ Configuration

### Change Ollama URL
Edit `src/lib/storage.ts`:
```typescript
ollamaBaseUrl: "http://your-ollama-url:11434"
```

### Change Default Model
Edit `src/lib/storage.ts`:
```typescript
ollamaModel: "your-model-name"
```

### Adjust Layout Defaults
Edit `src/lib/storage.ts`:
```typescript
leftWidth: 280,    // Default left panel width
rightWidth: 360,   // Default right panel width
```

## 🐛 Troubleshooting

### Ollama Connection Errors
1. Verify Ollama is running: `ollama serve`
2. Check URL in settings panel
3. Test API: `curl http://192.168.0.79:11436/api/version`
4. Ensure model is pulled: `ollama pull qwen2.5:7b-instruct-q4_K_M`

### Build Errors
```bash
pnpm install          # Reinstall dependencies
pnpm run build        # Try build again
```

### TypeScript Errors
```bash
pnpm tsc --noEmit     # Check types
```

### Tailwind Not Working
```bash
pnpm dev              # Restart dev server
# Check tailwind.config.ts content paths
```

## 📝 Development Tips

### Add New Component
1. Create in `src/components/`
2. Export from file
3. Import in `App.tsx` or parent component
4. Add TypeScript types in `src/types.ts` if needed

### Add New Storage Key
1. Add to `KEYS` const in `src/lib/storage.ts`
2. Create load/save functions
3. Use in components

### Debug Streaming
Add console.log in `ollamaStreamChat`:
```typescript
onToken: (t) => {
  console.log('Token:', t);
  // ... rest of code
}
```

## 🔄 Workflow

### Daily Development
```bash
pnpm dev              # Start dev server
# Make changes, hot reload
# Test in browser
Ctrl+C                # Stop server
```

### Before Commit
```bash
pnpm run lint         # Check code style
pnpm run build        # Verify build works
git add .
git commit -m "message"
```

### Deploy Desktop App
```bash
cargo tauri build     # Build for your OS
# Find installer in src-tauri/target/release/bundle/
```

## 📚 Resources

- [React 19 Documentation](https://react.dev)
- [Tailwind CSS Docs](https://tailwindcss.com)
- [TypeScript Handbook](https://www.typescriptlang.org/docs)
- [Vite Guide](https://vite.dev)
- [Tauri Documentation](https://tauri.app)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)

## 🎨 UI Customization

### Change Colors
Edit `src/index.css`:
```css
:root {
  /* Add custom CSS variables */
}
```

### Adjust Panel Sizes
Edit `src/lib/storage.ts` layout defaults

### Modify Component Styling
Components use Tailwind classes directly
- Search for `className=` in component files
- Modify Tailwind utility classes
- See [Tailwind Cheat Sheet](https://tailwindcss.com/docs/utility-first)

## 🤝 Contributing

1. Create feature branch
2. Make changes
3. Test thoroughly
4. Update documentation
5. Submit PR

## 📄 License

MIT License - See LICENSE file

---

**Current Version:** D1 (Streaming Chat)
**Next Version:** D2 (MCP Integration)
**Status:** ✅ Ready for development
