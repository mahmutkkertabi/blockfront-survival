# Blockfront Survival — Multiplayer prototype

A browser-based blocky first-person survival prototype with camera-held equipment models, mouse-wheel hotbar switching, a day/night cycle, hostile cube enemies, mining, building, and a room-code multiplayer mode.

## Survival mission

Complete all four goals to win: reach Day 5, mine 5 cyan crystal-ore blocks, place 10 blocks, and defeat 8 hostile cubes. Days last 90 seconds; hostiles appear during the night and retreat at dawn. The player carries a visible voxel forearm and a different model for each hotbar item.

## Controls

- `W A S D`: move
- Mouse: look around
- `Space`: jump
- Left click: mine / fire / swing
- Right click: place a block
- `1`–`6` or mouse wheel: switch held item
- `R`: reload
- `Esc`: release mouse / pause

## Run locally

1. Extract the project folder.
2. Open a terminal in the folder and run `python -m http.server 8000`.
3. Open http://localhost:8000 in a browser.

The browser needs internet access to load Three.js and PeerJS from their CDNs.

## Publish with GitHub Pages

1. Upload `index.html`, `style.css`, `game.js`, and optionally the README at the repository root (do not upload only the ZIP).
2. In **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/(root)`, and save.

## Play together

1. Both players open the same published URL.
2. The host clicks **CREATE MULTIPLAYER ROOM** and sends the 10-character code to their friend.
3. The friend enters the code and clicks **JOIN**.
4. Both players enter the world. Player avatars, held equipment selection, block changes, and the host's day/night clock are synchronized.

This remains a prototype. Each player's hostile encounters and mission progress are local; combat AI and player health/ammunition are not fully authoritative or synchronized across the network. Room codes are not a full authentication system. Share room codes only with people you trust.
