/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vercel auto-detects Vite; default base "/" is correct for a Vercel deploy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Unit tests run in node — pure parser/analytics/SMC logic, no DOM needed.
  test: {
    environment: "node",
    include: ["src/**/*.test.{js,jsx}"],
  },
});
