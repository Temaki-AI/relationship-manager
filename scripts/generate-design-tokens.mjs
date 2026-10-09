import { writeFileSync } from 'node:fs';
import { createThemeCss } from '../packages/design/src/tokens.ts';

writeFileSync(new URL('../app/design-tokens.css', import.meta.url), createThemeCss());
console.log('Generated Everclose web tokens from the shared design system.');
