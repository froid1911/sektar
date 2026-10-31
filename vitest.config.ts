import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    globals: true,
    // A desktop build leaves copies of the project here, tests included.
    exclude: [...configDefaults.exclude, "hosts/desktop/tauri-shell/**"],
    coverage: {
      provider: "v8",
      include: ["document-models/**/src/reducers/**"],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
  // A linked package resolves React from its own node_modules; its hooks need
  // the one copy that react-dom renders with.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [tsconfigPaths()],
});
