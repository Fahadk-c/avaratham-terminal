# Drop your sound clips here

Put `.mp3`, `.m4a`, `.aac`, `.wav`, or `.ogg` files directly in this folder
(`sounds/malayalam/`). The extension picks one at random (avoiding
back-to-back repeats) whenever a terminal command exits with a
non-zero code.

Notes:
- Avoid `.ogg` on macOS: `afplay` cannot decode it.
- Keep clips short (1-3 seconds) so they don't overlap with your next command.
- Only use audio you actually have the rights to use/distribute —
  see the Copyright note in the main README before publishing publicly.
- You can also point the extension at a different folder entirely via
  the `avarathamTerminal.soundsFolder` setting, instead of using this one.
