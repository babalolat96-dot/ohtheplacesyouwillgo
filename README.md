# If this is your vibe — London map

A single self-contained page: an interactive map of 244 London spots pulled from
every post on [so what's the sitch](https://sowhatsthesitch.substack.com).

- Search anywhere in London — 1,193 stations, areas and postcode districts are
  built in — and the map jumps there and ranks every spot nearest-first.
- Or use your live location for what's closest to you right now.
- Filter by vibe: date night, cheap eats under £10, matcha, listening bars,
  whimsy, green spaces, free things, and more.
- Every description is the writer's own words, with a link back to her post.

## Deploying

There is nothing to build. `index.html` is the whole site — Leaflet, the venue
data, the basemap and the gazetteer are all inlined.

**Netlify:** connect this repo; `netlify.toml` already sets publish to the repo
root with no build command. Every push to the default branch redeploys.

**GitHub Pages:** Settings → Pages → Deploy from branch → root.

## Updating

Replace `index.html` and push. That's the whole process.
