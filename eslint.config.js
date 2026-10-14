import globals from "globals";
export default [
  {
    files: ["src/gui/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    rules: { "no-undef": "error" },
  },
];
