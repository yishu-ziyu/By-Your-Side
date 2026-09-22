# Vendored: anti-slop

- Upstream: https://github.com/dmmulroy/anti-slop
- Pinned revision: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b
- Vendored on: 2026-09-23
- Contents: upstream `src/` (unmodified) + upstream `LICENSE` (MIT).
- `src/vendor/eslint-stylistic/**` is upstream's own vendored ESLint Stylistic code (MIT); its `UPSTREAM.md` carries provenance. Keep both together.
- Policy: upstream explicitly intends this to be vendored, not consumed as an npm dependency. These files are ours to read, change, and maintain. Record local edits here or in `docs/NOTES.md`.
- Updating: re-clone upstream, keep local rule/config changes, and prefer a three-way merge over force-replacing this directory.
