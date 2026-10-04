@README.md

## Rules for this repo

- `resolver/index.html` is frozen once QR codes are printed: every code embeds its TX. Treat changes to it as a new resolver, and ask the maintainer first.
- The resolver must stay a single file with no external scripts, fonts or CDNs.
- The editor is static files with no build step and no runtime dependencies beyond `editor/vendor/`.
- Nothing here uses AO or HyperBEAM. Don't reintroduce them.
- Deploys upload to Arweave permanently and publicly. Only deploy when asked.
