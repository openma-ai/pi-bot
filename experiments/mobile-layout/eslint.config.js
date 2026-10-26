import globals from 'globals';
export default [
 {files:['**/*.jsx'],languageOptions:{ecmaVersion:'latest',sourceType:'module',parserOptions:{ecmaFeatures:{jsx:true}},globals:globals.browser},rules:{'no-undef':'error'}},
 {files:['**/*.mjs'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:globals.node},rules:{'no-undef':'error'}}
];
