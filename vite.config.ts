import { defineConfig } from "vite";

export default defineConfig({
  publicDir: process.env.SNAP_CHARTS_DEMO === "1" ? ".demo" : "public",
});
