import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    files: ["**/*.cjs"],
    languageOptions: {
      globals: { module: "readonly", require: "readonly", process: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    ignores: ["**/out/**", "**/dist/**", "**/node_modules/**", "resources/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortSignal: "readonly",
        RequestInit: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        TextEncoder: "readonly",
        Response: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-undef": "off",
    },
  },
);
