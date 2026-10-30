const esbuild = require('esbuild');
const { reloadExtension } = require('./reload-extension');

// Reload the extension in Chrome after every successful rebuild. reloadExtension
// debounces, so the two contexts below rebuilding together still trigger one reload.
const reloadOnRebuild = {
  name: 'izitest-reload',
  setup(build) {
    let first = true;
    build.onEnd((result) => {
      // The initial build is not a change worth reloading for; the user is about to load
      // the extension anyway.
      if (first) { first = false; return; }
      if (result.errors.length === 0) reloadExtension({ quiet: true });
    });
  },
};

const SHARED_CONFIG = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  plugins: [reloadOnRebuild],
};

async function watch() {
  const backgroundContext = await esbuild.context({
    ...SHARED_CONFIG,
    entryPoints: ['src/background.ts'],
    outfile: 'dist/background.js',
  });

  const contentContext = await esbuild.context({
    ...SHARED_CONFIG,
    entryPoints: ['src/content.ts'],
    outfile: 'dist/content.js',
  });

  await backgroundContext.watch();
  await contentContext.watch();

  console.log('[IziTest] Watching for changes... (the extension reloads itself in Chrome after each rebuild)');
}

watch().catch(console.error);
