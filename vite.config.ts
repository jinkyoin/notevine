import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
// @ts-expect-error type error without @types/node package
import path from "node:path";
const host = process.env.TAURI_DEV_HOST;

type Req = { url?: string };
type Res = { setHeader: (k: string, v: string) => void; end: (body: unknown) => void };

/**
 * pdf.js needs its character maps (Korean and other CJK text) and standard fonts as
 * files. They are served from node_modules in dev and copied into the build, so the
 * repo keeps no copy of them.
 */
function pdfjsAssets() {
  const dirs = ["cmaps", "standard_fonts"];
  const root = path.resolve("node_modules/pdfjs-dist");
  return {
    name: "pdfjs-assets",
    configureServer(server: { middlewares: { use: (fn: (req: Req, res: Res, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/(cmaps|standard_fonts)\/([\w.-]+)$/.exec((req.url ?? "").split("?")[0]);
        const file = m && path.join(root, m[1], m[2]);
        if (!file || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(fs.readFileSync(file));
      });
    },
    generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: Uint8Array }) => void }) {
      for (const dir of dirs) {
        for (const name of fs.readdirSync(path.join(root, dir)) as string[]) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: fs.readFileSync(path.join(root, dir, name)) });
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), pdfjsAssets()],

  // Agent worktrees under .claude/ hold copies of the sources; don't test them twice.
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
