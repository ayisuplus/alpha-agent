import { defineConfig } from "vite";

export default defineConfig({
  root: "desktop/ui",
  base: "/ui/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rolldownOptions: {
      // lucide-react marks its modules "use client"; the directive is meaningless in this client-only bundle.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});
