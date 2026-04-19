import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        globIgnores: [
          "**/vad/ort-wasm-simd-threaded*.wasm",
          "**/vad/ort-wasm-simd-threaded*.mjs",
          "**/assets/ort-wasm-simd-threaded*.wasm",
          "**/assets/ort-wasm-simd-threaded*.mjs"
        ]
      },
      manifest: {
        name: "Voice Claude",
        short_name: "Voice Claude",
        description: "A lightweight thinking-partner voice app for walking conversations.",
        theme_color: "#f5efe2",
        background_color: "#f5efe2",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192.svg",
            sizes: "192x192",
            type: "image/svg+xml"
          },
          {
            src: "/pwa-512.svg",
            sizes: "512x512",
            type: "image/svg+xml"
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        ws: true
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: []
  }
});
