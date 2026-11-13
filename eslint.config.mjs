import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
export default [...nextVitals, ...nextTypescript, { ignores: ['.next/**', '.next-build/**', 'node_modules/**'] }, { rules: { '@next/next/no-html-link-for-pages': 'off' } }];
