import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

export default [{
  files: ["src/**/*.{ts,tsx,js,jsx}"],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  plugins: { solid },
  rules: solid.configs.typescript.rules,
}];
