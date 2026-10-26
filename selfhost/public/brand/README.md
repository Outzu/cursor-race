# Brand and vendor assets

Exports the game embeds, kept here with their sources so they can be re-cut.

## Ours

- `logo-source.png` / `logo.webp` - the mascot mark on the home screen
- `icon-source.png` / `favicon.png` - the tab icon
- `homedirect.svg` / `homedirect.webp` - the HomeDirect sponsor board
- `trophy-source.png` / `trophy.webp` - the button that opens the board on a phone
- `grass.webp` - the meadow's grass, a seamless vector texture rendered to 512px
  with Ghostscript (`-dEPSCrop -r81.92`) and encoded at webp quality 75
- `sfx/prepare.mp3` - the countdown cue, mono 64k; multiplayer only, since a
  single-player run has no gate to count down
- `sfx/taunt0..15.mp3` - the jeering mid-race, mono 64k. Where they land comes
  from the world seed, so everyone in a race hears the same one at the same
  point rather than each pilot being distracted at a different moment

The logo and the cue are embedded in `cursor-race.html` as data URIs rather
than fetched, so the game sounds and looks the same run as an artifact, where
there is no server to fetch them from. Re-cut them to the sizes they ship at:
the logo is the source cropped to its alpha bounds and resized to 700px wide
at WebP q80, and the cue is `ffmpeg -ac 1 -b:a 64k`.

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
