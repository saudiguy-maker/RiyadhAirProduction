import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    host: true,               // so your iPhone can reach the dev server on the LAN
    proxy: {
      "/api": "http://localhost:8080",
      "/stream": { target: "ws://localhost:8080", ws: true },
    },
  },
});
