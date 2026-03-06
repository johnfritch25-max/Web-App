const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".webmanifest": "application/manifest+json; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function createClientId() {
  return Math.random().toString(36).slice(2, 10);
}

function createRoom() {
  return {
    clients: new Set(),
    users: new Map(),
    screenSharers: new Set(),
    chatHistory: [],
    timer: {
      phase: "work",
      isRunning: false,
      remainingSec: 25 * 60,
      workSec: 25 * 60,
      breakSec: 5 * 60,
      endAt: null,
    },
  };
}

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom());
  }
  return rooms.get(roomId);
}

function emitRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const users = [...room.users.values()].map((user) => user.name);
  const timer = {
    phase: room.timer.phase,
    isRunning: room.timer.isRunning,
    remainingSec: room.timer.remainingSec,
    workSec: room.timer.workSec,
    breakSec: room.timer.breakSec,
  };

  for (const client of room.clients) {
    sendJson(client, { type: "room_state", users, timer });
  }
}

function broadcast(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const client of room.clients) {
    sendJson(client, payload);
  }
}

function findClientById(room, clientId) {
  for (const client of room.clients) {
    if (client.clientId === clientId) {
      return client;
    }
  }
  return null;
}

function cleanRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (room && room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function clampDuration(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(60, Math.min(120 * 60, Math.floor(parsed)));
}

function formatSystemMessage(text) {
  return {
    type: "chat_message",
    author: "System",
    message: text,
    sentAt: new Date().toISOString(),
  };
}

const server = http.createServer((req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requestPath).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end("Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.clientId = createClientId();
  ws.roomId = null;
  ws.userName = null;

  ws.on("message", (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch {
      sendJson(ws, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    if (data.type === "join_room") {
      const roomId = String(data.roomId || "").trim().slice(0, 32) || "main";
      const userName = String(data.userName || "Guest").trim().slice(0, 24) || "Guest";

      ws.roomId = roomId;
      ws.userName = userName;

      const room = getRoom(roomId);
      const existingPeers = [...room.users.values()].map((user) => ({
        peerId: user.id,
        userName: user.name,
      }));

      room.clients.add(ws);
      room.users.set(ws, { id: ws.clientId, name: userName });

      sendJson(ws, {
        type: "joined_ack",
        peerId: ws.clientId,
        roomId,
        userName,
      });

      sendJson(ws, {
        type: "room_peers",
        peers: existingPeers,
      });

      sendJson(ws, {
        type: "screen_share_snapshot",
        sharers: [...room.screenSharers],
      });

      sendJson(ws, {
        type: "chat_history",
        messages: room.chatHistory,
      });

      broadcast(roomId, {
        type: "peer_joined",
        peerId: ws.clientId,
        userName,
      });

      emitRoomState(roomId);

      broadcast(roomId, formatSystemMessage(`${userName} joined the room.`));
      return;
    }

    if (!ws.roomId) {
      sendJson(ws, { type: "error", message: "Join a room first." });
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) {
      return;
    }

    if (data.type === "chat_message") {
      const messageText = String(data.message || "").trim();
      if (!messageText) {
        return;
      }

      const messagePayload = {
        type: "chat_message",
        author: ws.userName,
        message: messageText.slice(0, 300),
        sentAt: new Date().toISOString(),
      };

      room.chatHistory.push(messagePayload);
      room.chatHistory = room.chatHistory.slice(-100);
      broadcast(ws.roomId, messagePayload);
      return;
    }

    if (data.type === "timer_start") {
      if (!room.timer.isRunning) {
        room.timer.isRunning = true;
        room.timer.endAt = Date.now() + room.timer.remainingSec * 1000;
        emitRoomState(ws.roomId);
      }
      return;
    }

    if (data.type === "timer_pause") {
      if (room.timer.isRunning && room.timer.endAt) {
        room.timer.remainingSec = Math.max(
          0,
          Math.ceil((room.timer.endAt - Date.now()) / 1000)
        );
      }
      room.timer.isRunning = false;
      room.timer.endAt = null;
      emitRoomState(ws.roomId);
      return;
    }

    if (data.type === "timer_reset") {
      room.timer.phase = "work";
      room.timer.isRunning = false;
      room.timer.endAt = null;
      room.timer.remainingSec = room.timer.workSec;
      emitRoomState(ws.roomId);
      return;
    }

    if (data.type === "timer_config") {
      room.timer.workSec = clampDuration(data.workSec, room.timer.workSec);
      room.timer.breakSec = clampDuration(data.breakSec, room.timer.breakSec);

      if (!room.timer.isRunning) {
        room.timer.phase = "work";
        room.timer.remainingSec = room.timer.workSec;
      }

      emitRoomState(ws.roomId);
      return;
    }

    if (
      data.type === "webrtc_offer" ||
      data.type === "webrtc_answer" ||
      data.type === "webrtc_ice"
    ) {
      const toPeerId = String(data.to || "").trim();
      if (!toPeerId) {
        return;
      }

      const targetClient = findClientById(room, toPeerId);
      if (!targetClient) {
        return;
      }

      sendJson(targetClient, {
        type: data.type,
        from: ws.clientId,
        userName: ws.userName,
        sdp: data.sdp || null,
        candidate: data.candidate || null,
      });
      return;
    }

    if (data.type === "screen_share_state") {
      const isSharing = Boolean(data.isSharing);
      if (isSharing) {
        room.screenSharers.add(ws.clientId);
      } else {
        room.screenSharers.delete(ws.clientId);
      }

      broadcast(ws.roomId, {
        type: "screen_share_update",
        peerId: ws.clientId,
        userName: ws.userName,
        isSharing,
      });
    }
  });

  ws.on("close", () => {
    if (!ws.roomId) {
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) {
      return;
    }

    const departing = room.users.get(ws) || { name: "User", id: ws.clientId };
    const departingName = departing.name;
    room.clients.delete(ws);
    room.users.delete(ws);
    room.screenSharers.delete(departing.id);

    broadcast(ws.roomId, {
      type: "peer_left",
      peerId: departing.id,
    });

    broadcast(ws.roomId, {
      type: "screen_share_update",
      peerId: departing.id,
      userName: departingName,
      isSharing: false,
    });

    broadcast(ws.roomId, formatSystemMessage(`${departingName} left the room.`));
    emitRoomState(ws.roomId);
    cleanRoomIfEmpty(ws.roomId);
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    const timer = room.timer;
    if (!timer.isRunning || !timer.endAt) {
      continue;
    }

    const nextRemaining = Math.max(0, Math.ceil((timer.endAt - now) / 1000));
    timer.remainingSec = nextRemaining;

    if (nextRemaining === 0) {
      if (timer.phase === "work") {
        timer.phase = "break";
        timer.remainingSec = timer.breakSec;
      } else {
        timer.phase = "work";
        timer.remainingSec = timer.workSec;
      }
      timer.endAt = now + timer.remainingSec * 1000;

      broadcast(
        roomId,
        formatSystemMessage(`Timer switched to ${timer.phase.toUpperCase()} mode.`)
      );
    }

    emitRoomState(roomId);
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`Virtual Study Room running on http://localhost:${PORT}`);
});
