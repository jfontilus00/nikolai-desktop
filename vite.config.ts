import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Change this to the port that your PowerShell probe printed (FOUND_OK_PORT=xxxx)
const DEV_PORT = 5180;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: DEV_PORT,
    strictPort: true,
  },
});
