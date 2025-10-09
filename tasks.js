const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/esm/types.d.ts`);
copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/cjs/types.d.ts`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/esm/package.json`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/cjs/package.json`);
let text = readFileSync(`${__dirname}/build/cjs/index.js`, 'utf8');
text = text.replace(
    'exports.default = DockerPlugin;',
    `module.exports = DockerPlugin;
module.exports.DockerManagerOfOwnContainers = DockerManagerOfOwnContainers;
module.exports.DockerManager = DockerManager;
module.exports.default = DockerPlugin;`,
);
writeFileSync(`${__dirname}/build/cjs/index.js`, text, 'utf8');
