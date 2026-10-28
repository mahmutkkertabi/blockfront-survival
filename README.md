# Blockfront Survival — Multiplayer prototype

A browser-based voxel survival prototype with a basic room-code multiplayer mode.

## Run locally

1. Extract the project folder.
2. Open a terminal in the folder and run `python -m http.server 8000`.
3. Open http://localhost:8000 in a browser.

The browser needs internet access to load Three.js and PeerJS from their CDNs.

## Publish with GitHub Pages

1. Create a GitHub repository.
2. Upload `index.html`, `style.css`, `game.js`, and optionally this README at the repository root (do not upload only the ZIP).
3. In **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/(root)`, and save.
4. Open the published website and allow a minute for the first deployment.

## Play together

1. Both players open the same published URL.
2. The host clicks **CREATE MULTIPLAYER ROOM** and waits for the room code to appear.
3. The host sends the ten-character code to the friend.
4. The friend enters the code and clicks **JOIN**.
5. Both players enter the world. Remote player avatars and block mining/placement changes are synchronized. Room codes use a cryptographically generated 10-character value; rooms accept one guest.

The room host must keep their tab open. The game uses PeerJS Cloud for connection signaling and direct WebRTC data connections. Peer-to-peer connections may fail on some restricted networks or NAT configurations. This is a prototype, not a persistent or authoritative game server. Player health, hunger, and ammunition are currently local; combat and enemy behavior are not synchronized as a full multiplayer combat system.


## Security and testing notes

- The archive contains source files only (HTML/CSS/JavaScript/Markdown), not an executable installer.
- JavaScript syntax and ZIP integrity should be checked before publishing. This is a prototype and has not had an independent professional penetration test or a confirmed two-device multiplayer test.
- The game loads Three.js and PeerJS from pinned HTTPS CDN URLs. Those third-party scripts execute in the page, so users rely on the CDN/package supply chain as well as this source code.
- Room codes are 10 characters generated with Web Crypto, but this is not a full account/authentication system. Share codes only with people you trust.
