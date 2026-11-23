// Version and build. The packaged server runs from app.asar.unpacked, where package.json
// isn't, so `npm run build:info` writes both into build.json; a dev checkout reads package.json.
module.exports = (() => { try { return require('../build.json'); } catch { return { version: require('../package.json').version, build: 'dev' }; } })();
