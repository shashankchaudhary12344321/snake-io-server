# Snake.IO Game Server

Authoritative real-time multiplayer server for the Snake.IO game.
Handles movement, collisions, food, and bots — this is what makes
gameplay smooth and fair instead of relying on Firebase syncing.

## What this does NOT do

Login, shop, and leaderboard stay on Firebase — this server only
handles live gameplay (positions, collisions, food).

## Deploy to Railway (recommended, free tier available)

1. Go to https://railway.app and sign up / log in (GitHub login is easiest).
2. Click **"New Project"** → **"Deploy from GitHub repo"**
   - If you don't have this on GitHub yet: create a new GitHub repo,
     upload `server.js`, `package.json`, and this `README.md` to it,
     then pick that repo in Railway.
   - Alternatively, use Railway's **"Empty Project"** then drag-and-drop
     these files in through their dashboard if a GitHub repo feels
     like too many steps.
3. Railway will detect this is a Node.js app and run `npm install` then `npm start` automatically.
4. Once deployed, click on the service → **Settings** → **Networking** →
   **Generate Domain**. This gives you a public URL like:
   `https://snake-io-server-production.up.railway.app`
5. Copy that URL.

## Connect the game to this server

Open your `snake-multiplayer-fixed.html` file, find this line near the top of the `<script>` section:

```js
const GAME_SERVER_URL = "PASTE_YOUR_RAILWAY_URL_HERE";
```

Replace it with your real Railway URL, e.g.:

```js
const GAME_SERVER_URL = "https://snake-io-server-production.up.railway.app";
```

Save the file. That's it — the game will now use this server for real-time
gameplay instead of Firebase.

## Testing locally first (optional, but recommended)

If you have Node.js installed on your own computer:

```
cd snake-server
npm install
npm start
```

Then temporarily set `GAME_SERVER_URL = "http://localhost:3000"` in the
HTML file and open it in a browser to test before deploying.

## Checking it's alive

Visit `https://your-railway-url/health` in a browser — it should return
something like `{"ok":true,"players":0}`. If you see that, the server is
running correctly.
