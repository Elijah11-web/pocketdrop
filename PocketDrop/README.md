# PocketDrop

PocketDrop is a small, no-account website for moving files between your own devices. Drop files or folders, paste text, and submit to get a four-digit code. Enter that code on another device to download files or copy the text.

## Run it on your computer

1. Install Node.js 18 or newer.
2. Open a terminal in this folder and run `npm start`.
3. Open `http://localhost:3000`.

To test from another device on the same Wi-Fi, open `http://YOUR-COMPUTER-IP:3000` there. Your computer’s firewall must allow connections on port 3000.

## Hosting it online

This app needs a Node.js host with a writable temporary disk. Deploy this folder to a Node hosting service, set the start command to `npm start`, enable HTTPS and redirect HTTP traffic to HTTPS, and use the HTTPS address on both devices. The app has no database or sign-in system. If the host is behind a trusted proxy that supplies the real client IP in `X-Forwarded-For`, set `TRUST_PROXY=1`; do not enable that setting unless the proxy is trusted.

## Privacy and limits

- Room codes are randomly generated four-digit codes. Anyone who has a code can see, upload, and download files in that room, so share the code only with your own devices. Because four-digit codes are easier to guess than longer codes, the server limits incorrect code attempts to five per IP every 15 minutes.
- Files are stored temporarily on the computer or hosting service running PocketDrop, under the operating system's temporary directory. Downloading a file, closing a browser, or restarting a browser does not remove it. The room and its files stay available until one hour after the room is created, then are deleted. A server restart clears them when the app starts again.
- File contents are encrypted on the temporary disk with AES-256-GCM. The key stays in server memory and is discarded when the room expires or the server restarts. The server decrypts files for downloads, so this is encryption at rest, not end-to-end encryption; the hosting service can access files while a room is active.
- Each file can be up to 100 MB; a room can hold up to 20 files and 500 MB total.
- Basic protections include cross-site request checks, security response headers, a limit of five incorrect room-code checks per IP every 15 minutes, 10 room creations and 20 uploads per IP every 15 minutes, and per-room file limits. Reverse-proxy IP handling must be configured correctly for per-IP limits to work as intended.
- Run one server instance at a time because each instance has its own in-memory room list. This is suitable for personal or small-team transfers; it is not a hardened public file-sharing service. Avoid sending highly sensitive files through a server you do not control.
