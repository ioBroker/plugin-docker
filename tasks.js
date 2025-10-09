const { copyFileSync } = require('node:fs');
copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/esm/types.d.ts`);
copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/cjs/types.d.ts`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/esm/package.json`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/cjs/package.json`);
