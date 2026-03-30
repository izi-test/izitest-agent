const esbuild = require('esbuild');

const SHARED_CONFIG = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
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

  console.log('[BrowserPilot] Watching for changes...');
}

watch().catch(console.error);
