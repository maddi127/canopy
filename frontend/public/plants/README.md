# Plant photo cutouts (3D yard view)

Drop **transparent-background PNGs** here. The 3D yard view (`/diy/yard-3d`) renders
each as a camera-facing photo billboard; if a file is missing it falls back to the
procedural model.

Expected filenames (exact, lowercase):

- `bluebeard.png`
- `fernbush.png`
- `columbine.png`
- `lilac.png`
- `tree.png`   ← used for existing trees (and any selected tree)

Tips:
- Background must be transparent (alpha), not white — the renderer keys on alpha.
- Front-on, upright shots work best (the billboard always faces the camera, stays vertical).
- Image aspect ratio is preserved; the plant is scaled to its mature height, so a wide
  shrub photo should be wider than tall.

To add a new species: name the file `<slug>.png` and map the species name to that slug
in `billboardSlug()` in `src/components/Yard3D.tsx`.
