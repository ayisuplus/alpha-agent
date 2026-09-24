import { defineConfig } from "vite";

export default defineConfig({
  root: "desktop/ui",
  base: "/ui/",
  build: { outDir: "../dist", emptyOutDir: true },
});
