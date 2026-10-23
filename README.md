# Area 51 · Day Shift

A first-person UFO simulator in the browser. Clock in at Groom Lake, walk Hangar 9, board ARV-3 and fly it out the door. Then take it anywhere on Earth at up to Mach 150.

**Play:** https://area51.ysuriadesign.co

## Features
- A walkable hangar with a rigged ground crew, a cockpit with a pilot body, and a chase camera (V)
- A whole Earth to fly over: streamed satellite imagery, terrain, and OpenStreetMap buildings for real cities
- Ten speed gears (1–0, − =), from a slow hover up to Mach 150 in Overdrive (Q), with a liquid lens and chromatic aberration at the screen edges
- Map search and warp (M / J), so you can type a place and go
- Always daytime, wherever you are

## Run locally
```bash
npm install
npm run dev
```
Optional: copy `.env.example` to `.env.local` and add a Google Map Tiles key for photorealistic 3D cities.

Built with Three.js and Vite. Crew models: Microsoft Rocketbox (MIT).
