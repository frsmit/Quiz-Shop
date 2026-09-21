/**
 * Runs both Vite builds in watch mode (main bundle + content script) so the
 * unpacked extension in dist/ stays current while developing.
 */
import { spawn } from 'node:child_process';

const targets = [
  ['vite', ['build', '--watch', '--mode', 'development']],
  ['vite', ['build', '--watch', '--mode', 'development', '--config', 'vite.content.config.ts']],
];

const children = targets.map(([cmd, args]) =>
  spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' }),
);

const shutdown = () => children.forEach((child) => child.kill());
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
children.forEach((child) => child.on('exit', (code) => code && shutdown()));
