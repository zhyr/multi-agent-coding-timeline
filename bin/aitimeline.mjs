#!/usr/bin/env node
// Thin launcher: all logic lives in the compiled TypeScript entry point.
try {
  await import('../dist/cli/main.js');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ERR_MODULE_NOT_FOUND') {
    console.error('aitimeline: compiled output not found. Run `npm run build` first.');
    process.exit(70);
  }
  throw error;
}
