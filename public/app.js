const joinCard = document.getElementById("joinCard");
const roomLayout = document.getElementById("roomLayout");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const roomLabel = document.getElementById("roomLabel");

const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

const timerPhase = document.getElementById("timerPhase");
const timerDisplay = document.getElementById("timerDisplay");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");
const configForm = document.getElementById("configForm");
const workInput = document.getElementById("workInput");
const breakInput = document.getElementById("breakInput");

const radioPlayer = document.getElementById("radioPlayer");
const radioUrlInput = document.getElementById("radioUrlInput");
const loadRadioBtn = document.getElementById("loadRadioBtn");
const userList = document.getElementById("userList");
const installBtn = document.getElementById("installBtn");

document.body.classList.add("join-screen");

let socket = null;
let deferredPrompt = null;
let currentUserName = "";
let currentRoomId = "";
let reconnectTimeoutId = null;
let reconnectAttempts = 0;
let joinedRoom = false;

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatSeconds(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function appendMessage({ author, message, sentAt }) {
  const line = document.createElement("div");
  line.className = "chat-line";

  const time = sentAt ? new Date(sentAt).toLocaleTimeString() : "";
  const name = document.createElement("strong");
  name.textContent = author || "User";
  line.appendChild(name);

  if (time) {
    const meta = document.createElement("small");
    meta.textContent = ` ${time}`;
    line.appendChild(meta);
  }

  line.appendChild(document.createElement("br"));

  const text = document.createTextNode(message || "");
  line.appendChild(text);

  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type, ...payload }));
}

function queueReconnect() {
  if (!joinedRoom || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || reconnectTimeoutId) {
    return;
  }

  const delay = BASE_RECONNECT_DELAY_MS * Math.min(10, 2 ** reconnectAttempts);
  reconnectAttempts += 1;

  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    appendMessage({
      author: "System",
      message: "Reconnecting...",
      sentAt: new Date().toISOString(),
    });
    connectWebSocket(currentUserName, currentRoomId);
  }, delay);
}

function connectWebSocket(userName, roomId) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    send("join_room", { userName, roomId });
  });

  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "chat_history") {
      chatLog.innerHTML = "";
      for (const message of data.messages) {
        appendMessage(message);
      }
      return;
    }

    if (data.type === "chat_message") {
      appendMessage(data);
      return;
    }

    if (data.type === "room_state") {
      timerPhase.textContent = data.timer.phase.toUpperCase();
      timerDisplay.textContent = formatSeconds(data.timer.remainingSec);
      workInput.value = Math.round(data.timer.workSec / 60);
      breakInput.value = Math.round(data.timer.breakSec / 60);

      userList.innerHTML = "";
      for (const user of data.users) {
        const li = document.createElement("li");
        li.textContent = user;
        userList.appendChild(li);
      }
    }
  });

  socket.addEventListener("close", () => {
    appendMessage({
      author: "System",
      message: "Disconnected from server.",
      sentAt: new Date().toISOString(),
    });
    queueReconnect();
  });

  socket.addEventListener("error", () => {
    queueReconnect();
  });
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const userName = nameInput.value.trim();
  const roomId = roomInput.value.trim().toLowerCase();

  if (!userName || !roomId) {
    return;
  }

  currentUserName = userName;
  currentRoomId = roomId;
  joinedRoom = true;

  roomLabel.textContent = `Room: ${roomId}`;
  joinCard.classList.add("hidden");
  roomLayout.classList.remove("hidden");
  document.body.classList.remove("join-screen");
  connectWebSocket(userName, roomId);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }
  send("chat_message", { message });
  chatInput.value = "";
});

startBtn.addEventListener("click", () => send("timer_start"));
pauseBtn.addEventListener("click", () => send("timer_pause"));
resetBtn.addEventListener("click", () => send("timer_reset"));

configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const workSec = Number(workInput.value) * 60;
  const breakSec = Number(breakInput.value) * 60;
  send("timer_config", { workSec, breakSec });
});

loadRadioBtn.addEventListener("click", () => {
  const url = radioUrlInput.value.trim();
  if (!url) {
    return;
  }
  radioPlayer.src = url;
  radioPlayer.play().catch(() => {});
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) {
    return;
  }

  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

window.addEventListener("online", () => {
  if (!joinedRoom) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectWebSocket(currentUserName, currentRoomId);
  }
});
