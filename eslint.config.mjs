import babelParser from '@babel/eslint-parser';
import hooks from 'eslint-plugin-react-hooks';
export default [
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          plugins: [['@babel/plugin-syntax-typescript', { isTSX: true }]],
        },
      },
    },
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
];
