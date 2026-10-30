import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it
  server: {
    port: 5173,
    // .env.local leaves the API base URL empty, so calls are same-origin and
    // this forwards them. Without it Vite answered /v1/* with index.html.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
