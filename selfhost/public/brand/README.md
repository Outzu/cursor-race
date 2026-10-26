# Brand and vendor assets

Exports the game embeds, kept here with their sources so they can be re-cut.

## Ours

- `logo-source.png` / `logo.webp` - the mascot mark on the home screen
- `icon-source.png` / `favicon.png` - the tab icon
- `trophy-source.png` / `trophy.webp` - the button that opens the board on a phone
- `board.webp` - the hoarding: our own board, built from shapes in three.js, the
  same construction as the desk's `board3d.js` (github.com/Outzu/cursorclash-billboard)
  and the live one on the game's front page. Rendered once with the ground and
  the fog off and no perspective from the desk's `sprite.html`,
  `__sprite(480, 564, -34, 6, 1, true)`, cropped to its bounds and scaled to
  240 wide. The screen's corners come out of the same call and go in `PANEL`
  in the game, scaled with the picture
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
