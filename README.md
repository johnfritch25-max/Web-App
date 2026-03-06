# Virtual Study Room (PWA)

Full-stack Progressive Web App with:
- Real-time room chat (WebSocket)
- Shared Pomodoro timer (synced for all users in room)
- Lo-fi radio stream player

## Run locally

```bash
npm install
npm start
```

Open: `http://localhost:3000`

## Deploy for a permanent public link (Render)

1. Push this project to GitHub.
2. Go to Render dashboard: `https://render.com`.
3. Click **New** → **Blueprint**.
4. Connect your GitHub repo and select this project.
5. Render auto-detects `render.yaml`; click **Apply**.
6. Wait for deploy to finish.
7. Your permanent URL will be like:
   - `https://virtual-study-room.onrender.com`

Notes:
- WebSockets are supported by Render web services.
- Free plan services may sleep when idle.
