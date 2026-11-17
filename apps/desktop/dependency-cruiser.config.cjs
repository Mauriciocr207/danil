const FEATURES = "src/features";
module.exports = {
  forbidden: [
    {
      name: "feature-interface",
      severity: "error",
      from: { path: `^${FEATURES}/([^/]+)/` },
      to: { path: `^${FEATURES}/[^/]+/`, pathNot: [`^${FEATURES}/$1/`, `^${FEATURES}/[^/]+/(index|store)\\.tsx?$`] },
    },
    {
      name: "app-feature-interface",
      severity: "error",
      from: { pathNot: `^${FEATURES}/` },
      to: { path: `^${FEATURES}/`, pathNot: `^${FEATURES}/[^/]+/(index|store)\\.tsx?$` },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "no-unresolved", severity: "error", from: { path: "^src/" }, to: { couldNotResolve: true, path: "^\\." } },
  ],
  options: {
    doNotFollow: { path: "node_modules|^\\.\\./" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["solid", "import", "types", "default"],
      extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
    },
  },
};
