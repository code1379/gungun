import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
const alias = {
  "@gungun/domain": resolve("../../packages/domain/src/index.ts"),
};
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@gungun/domain"] })],
    resolve: { alias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: { resolve: { alias }, plugins: [react(), tailwindcss()] },
});
