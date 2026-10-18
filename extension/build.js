const esbuild = require('esbuild');
const { reloadExtension } = require('./reload-extension');

esbuild.build({
  entryPoints: ['src/background.ts', 'src/content.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  // Define required variables for puppeteer
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.DEBUG': '""',
  },
  // Prevent ESBuild from dynamically bundling these unused Node paths
  external: [
    'node:path',
    '@puppeteer/browsers',
    'crypto'
  ]
}).then(async () => {
  console.log("Build complete!");
  await reloadExtension();
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
