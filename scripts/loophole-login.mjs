#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ensureLoopholeBinary } from './loophole-binary.mjs';

const bin = await ensureLoopholeBinary(console.log);
console.log('\nLoophole login (one-time). Open the link in the browser when prompted.\n');

const child = spawn(bin, ['account', 'login'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
