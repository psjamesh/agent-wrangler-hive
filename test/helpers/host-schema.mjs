import { createRequire } from 'node:module';
import path from 'node:path';

if (!process.env.HIVE_TEST_CORE) throw new Error('Set HIVE_TEST_CORE to a core checkout with dependencies installed (API 2.1 or later).');
const require = createRequire(path.resolve(process.env.HIVE_TEST_CORE, 'package.json'));
export const { z } = require('zod');
export const schema = { z };
