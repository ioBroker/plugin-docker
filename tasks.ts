// Post-build step, run by `npm run postbuild` after esm2cjs.
// Node executes this file directly via type stripping, so only erasable TypeScript syntax is allowed here.
// Built-in modules are loaded with `process.getBuiltinModule()` instead of `import`: package.json has no
// `"type"` field, and an `import` statement would make Node reparse this file as ESM and print a
// MODULE_TYPELESS_PACKAGE_JSON warning on every build.
const { copyFileSync, readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');

copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/esm/types.d.ts`);
copyFileSync(`${__dirname}/src/types.d.ts`, `${__dirname}/build/cjs/types.d.ts`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/esm/package.json`);
copyFileSync(`${__dirname}/package.json`, `${__dirname}/build/cjs/package.json`);

// Make `require('@iobroker/plugin-docker')` return DockerPlugin itself, with the managers hung off it.
const cjsIndexPath = `${__dirname}/build/cjs/index.js`;
const cjsDefaultExport = 'exports.default = DockerPlugin;';
const cjsIndex: string = readFileSync(cjsIndexPath, 'utf8');
if (!cjsIndex.includes(cjsDefaultExport)) {
    throw new Error(`"${cjsDefaultExport}" not found in ${cjsIndexPath}. Did the exports of src/index.ts change?`);
}
writeFileSync(
    cjsIndexPath,
    cjsIndex.replace(
        cjsDefaultExport,
        `module.exports = DockerPlugin;
module.exports.DockerManagerOfOwnContainers = DockerManagerOfOwnContainers_1.default;
module.exports.DockerManager = DockerManager_1.default;
module.exports.default = DockerPlugin;`,
    ),
    'utf8',
);
