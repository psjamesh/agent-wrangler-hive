import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest } from './server/manifest.js';

export const dir = path.dirname(fileURLToPath(import.meta.url));

export default createManifest({ dir });
