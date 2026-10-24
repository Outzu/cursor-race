# Brand and vendor assets

Exports the game embeds, kept here with their sources so they can be re-cut.

## Ours

- `logo-source.png` / `logo.webp` - the wordmark on the home screen
- `icon-source.png` / `favicon.png` - the tab icon
- `homedirect.svg` / `homedirect.webp` - the HomeDirect sponsor board

## Not ours

### billboard.glb -> board.webp

- **Author:** DARKLORD (@DARK_2LORD2)
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) - attribution required
- **Source:** https://sketchfab.com/3d-models/billboard-800c324581684cdbaa0a074ab3f01c0c

Credit is carried in `ART_CREDITS` in `cursor-race.html`, which the Terms screen
prints, so it cannot drift out of step with what ships.

Unlike the CC BY-NC cursor artwork, CC BY permits commercial use - this model
adds no constraint on ever monetising the game.

`../../tools/render-board.html` turns the model into the sprite: open it through
the dev server, then `__export('board.webp', 240, -74, 8, 0.58)`. The panel's
corners in the sprite live in `PANEL` in the game; they were found by taking the
diagonal extremes of the largest bright region, and the top and bottom edges came
out identical, so the face is a true parallelogram and a plain affine transform
lays any sponsor's logo onto it.
