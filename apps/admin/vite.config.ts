import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // .env.local leaves the API base URL empty, so calls are same-origin and
    // this forwards them. Without it Vite answered /v1/* with index.html.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
