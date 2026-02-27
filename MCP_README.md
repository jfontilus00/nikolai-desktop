# MCP Tools Support

Nikolai Desktop now supports **Model Context Protocol (MCP)** tools, allowing you to connect external tool servers and use their capabilities directly from the chat interface.

## 🎯 What is MCP?

MCP (Model Context Protocol) is a protocol that allows AI models to interact with external tools and services. Think of it as a standardized way for AI to use calculators, file systems, web browsers, and more.

## 🚀 Quick Start

### 1. Install an MCP Server

```bash
# Example: Install the official MCP tools server
npm install -g @modelcontextprotocol/server-tools
```

### 2. Start Nikolai Desktop

```bash
pnpm dlx @tauri-apps/cli@1.5.9 dev
```

### 3. Configure MCP Server

1. Open the **Tools** tab in the right panel
2. Enter configuration:
   - **Command**: `node`
   - **Args**: `C:\path\to\mcp-server.js --stdio`
   - **CWD** (optional): Working directory
3. Click **Connect**
4. Click **List tools** to see available tools

### 4. Use Tools in Chat

Type commands in the chat:

```
/tool calculator {"expression": "2 + 2 * 3"}
/tool readFile {"uri": "file:///C:/test.txt"}
/tool listDirectory {"uri": "file:///C:/"}
```

## 📚 Available Tools

The available tools depend on your MCP server. Common tools include:

- **Calculator** - Evaluate mathematical expressions
- **File System** - Read/write files, list directories
- **Web Search** - Search the internet
- **Code Execution** - Run code snippets
- **Custom Tools** - Any tool your server provides

## 🔧 Configuration

### MCP Server Setup

Your MCP server must:
- Communicate over STDIO (stdin/stdout)
- Implement JSON-RPC 2.0 protocol
- Support MCP methods:
  - `initialize` - Connection handshake
  - `tools/list` - List available tools
  - `tools/call` - Execute tools

### Example MCP Server

```javascript
// mcp-server.js
const { stdioServer } = require('@modelcontextprotocol/server');

const server = stdioServer({
  // Your tool implementations here
  tools: {
    calculator: {
      description: 'Evaluate mathematical expressions',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string' }
        }
      }
    }
  }
});

server.run();
```

## 🎨 UI Features

### Tools Panel

The Tools panel provides:

1. **Connection Status** - See if connected to an MCP server
2. **Configuration Form** - Set up your MCP server
3. **Tool List** - View all available tools with descriptions
4. **Quick Test** - Test tools without using chat
5. **Call Log** - Review recent tool calls and results

### Tool Call Log

Each tool call is logged with:
- Tool name
- Arguments used
- Result or error
- Timestamp
- Success/failure indicator

## 🔍 Technical Details

### Protocol Implementation

- **JSON-RPC 2.0** over STDIO
- **Content-Length** framing (LSP-style)
- **Newline-delimited** JSON fallback
- **15-second timeout** on tool calls
- **Async request/response** handling

### Architecture

```
┌─────────────────────────────────────────────────┐
│              Nikolai Desktop                    │
├─────────────────┬───────────────┬───────────────┤
│   Frontend      │   Tauri IPC   │   Backend     │
│   (React/TS)    │               │   (Rust)      │
├─────────────────┼───────────────┼───────────────┤
│ • ToolsPanel    │ • invoke()    │ • McpClient   │
│ • /tool parser  │ • commands    │ • JSON-RPC    │
│ • Tool logging  │               │ • STDIO       │
└─────────────────┴───────────────┴───────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │  MCP Server     │
              │  (External)     │
              └─────────────────┘
```

### File Structure

```
src/
├── lib/
│   ├── mcp.ts          # Tauri command wrappers
│   ├── toolCmd.ts      # Command parser
│   └── toolLog.ts      # Logging utilities
├── components/
│   ├── ToolsPanel.tsx  # Tools UI
│   └── RightPanel.tsx  # Updated with Tools tab
└── App.tsx             # Tool command routing

src-tauri/
├── src/
│   ├── mcp.rs          # MCP protocol implementation
│   └── main.rs         # Command registration
└── Cargo.toml          # Dependencies
```

## 🐛 Troubleshooting

### Connection Issues

**Problem**: Can't connect to MCP server  
**Solution**: 
- Verify the command and arguments are correct
- Check that the MCP server is installed and accessible
- Ensure the server supports STDIO communication

### Tool Not Found

**Problem**: Tool doesn't appear in list  
**Solution**:
- Click "List tools" to refresh
- Verify the MCP server implements the tool
- Check server logs for errors

### Tool Call Fails

**Problem**: Tool execution returns error  
**Solution**:
- Check the tool call log for details
- Verify JSON arguments are correct
- Ensure the tool is properly implemented on the server

## 📖 Advanced Usage

### Multiple MCP Servers

Currently, only one MCP server can be connected at a time. To switch servers:
1. Disconnect current server
2. Update configuration
3. Connect to new server

### Custom Tool Servers

You can create your own MCP server:

```javascript
const { stdioServer } = require('@modelcontextprotocol/server');

const server = stdioServer({
  tools: {
    myCustomTool: {
      description: 'My amazing tool',
      inputSchema: { /* schema */ },
      run: async (args) => {
        // Your implementation
        return { result: 'success' };
      }
    }
  }
});

server.run();
```

### Tool Schema Validation

While the current implementation passes arguments as-is, future versions will support schema validation to ensure correct tool usage.

## 🔮 Future Enhancements

Planned features:
- [ ] Multiple concurrent MCP servers
- [ ] Tool schema validation
- [ ] Auto-complete for tool names
- [ ] Tool documentation display
- [ ] Auto-reconnect on failure
- [ ] Tool categories and filtering
- [ ] Tool permissions and security
- [ ] Tool history search

## 📝 API Reference

### Frontend Functions

```typescript
// Check connection status
const status = await mcpStatus();

// Connect to MCP server
await mcpConnect({
  command: 'node',
  args: ['server.js', '--stdio'],
  cwd: '/path/to/server'
});

// Disconnect
await mcpDisconnect();

// List available tools
const tools = await mcpListTools();

// Call a tool
const result = await mcpCallTool('calculator', {
  expression: '2 + 2'
});
```

### Backend Commands

```rust
// Rust commands available via Tauri invoke:
mcp_status()          // -> McpStatus
mcp_connect(cfg)      // -> McpStatus
mcp_disconnect()      // -> McpStatus
mcp_list_tools()      // -> Vec<Value>
mcp_call_tool(name, args) // -> Value
```

## 🤝 Contributing

If you're building MCP tools or servers:
1. Follow the MCP specification
2. Implement JSON-RPC 2.0 over STDIO
3. Support the standard MCP methods
4. Test with Nikolai Desktop

## 📚 Resources

- [MCP Specification](https://modelcontextprotocol.io)
- [MCP Tools Server](https://github.com/modelcontextprotocol/server-tools)
- [MCP Examples](https://github.com/modelcontextprotocol/examples)

---

**Version**: 1.0.0  
**Last Updated**: January 27, 2026  
**Status**: ✅ Production Ready
