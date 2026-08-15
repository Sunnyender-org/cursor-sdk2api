import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/console/",
  build: {
    outDir: "../dist/console",
    emptyOutDir: true,
    sourcemap: false,
  },
});
