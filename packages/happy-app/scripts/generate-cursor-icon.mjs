#!/usr/bin/env node
/**
 * Generates icon-cursor.png from icon-cursor.svg (128×128, for Avatar flavor icon).
 * Run: yarn generate:cursor-icon
 *
 * Official Cursor brand assets (cube logo, app icons): https://cursor.com/brand
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const svgPath = join(root, 'sources/assets/images/icon-cursor.svg');
const pngPath = join(root, 'sources/assets/images/icon-cursor.png');

const svg = readFileSync(svgPath);
const size = 128;

const png = await sharp(svg)
  .resize(size, size)
  .png()
  .toBuffer();

writeFileSync(pngPath, png);
console.log(`Wrote ${pngPath} (${size}×${size})`);
