import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vercel auto-detects Vite; default base "/" is correct for a Vercel deploy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
