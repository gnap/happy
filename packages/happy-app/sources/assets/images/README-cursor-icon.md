# Cursor icon

`icon-cursor.png` is sourced from **Cursor’s official brand assets**:

- **Brand guidelines**: https://cursor.com/brand  
- **Download**: [cursor-brand-assets.zip](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip)

Current file: **General Logos → Cube → PNG → CUBE_2D_LIGHT.png**, resized to 128×128. This is the cube-only logo (no app-icon frame), so it displays correctly as the Avatar flavor icon. Cursor icon is shown in official colors (no tint).

To refresh from the brand pack: download the zip, extract `General Logos/Cube/PNG/CUBE_2D_LIGHT.png`, then resize to 128×128 and overwrite `icon-cursor.png` (e.g. `sips -z 128 128 CUBE_2D_LIGHT.png --out icon-cursor.png`).

The in-repo `icon-cursor.svg` is a fallback I-beam placeholder; run `yarn generate:cursor-icon` to regenerate a placeholder PNG from it if needed.
