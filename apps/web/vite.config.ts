import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API already serves the built files, so the dev server proxies the same paths it will
// be mounted behind. Keeping the list explicit means a new API route has to be added here
// deliberately rather than shadowing a client route by accident.
const API_PATHS = ["/health", "/brief", "/catalogue", "/research", "/ledger", "/mandate", "/invest", "/receipt", "/auth"];

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        proxy: Object.fromEntries(
            API_PATHS.map((p) => [p, { target: "http://localhost:4021", changeOrigin: false }]),
        ),
    },
    build: { outDir: "dist", emptyOutDir: true },
});
