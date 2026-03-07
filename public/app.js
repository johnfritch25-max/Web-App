const joinCard = document.getElementById("joinCard");
const roomLayout = document.getElementById("roomLayout");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const roomLabel = document.getElementById("roomLabel");

const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

const radioPlayer = document.getElementById("radioPlayer");
const radioUrlInput = document.getElementById("radioUrlInput");
const loadRadioBtn = document.getElementById("loadRadioBtn");
const userList = document.getElementById("userList");
const installBtn = document.getElementById("installBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");
const startCallBtn = document.getElementById("startCallBtn");
const toggleMicBtn = document.getElementById("toggleMicBtn");
const toggleCamBtn = document.getElementById("toggleCamBtn");
const shareScreenBtn = document.getElementById("shareScreenBtn");
const leaveCallBtn = document.getElementById("leaveCallBtn");
const callStatus = document.getElementById("callStatus");
const connectionStatus = document.getElementById("connectionStatus");
const sharingStatus = document.getElementById("sharingStatus");

document.body.classList.add("join-screen");

let socket = null;
let deferredPrompt = null;
let currentUserName = "";
let currentRoomId = "";
let reconnectTimeoutId = null;
let reconnectAttempts = 0;
let joinedRoom = false;
let selfPeerId = "";
let localStream = null;
let inCall = false;
let isScreenSharing = false;
let screenTrack = null;
let cameraTrack = null;

const knownPeers = new Map();
const peerConnections = new Map();
const sharingPeers = new Map();

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 1000;
let configuredIceServers = [{ urls: "stun:stun.l.google.com:19302" }];

function normalizeIceServers(iceServers) {
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }

  const normalized = [];
  for (const server of iceServers) {
    if (!server || !server.urls) {
      continue;
    }

    const urls = Array.isArray(server.urls)
      ? server.urls.filter((url) => typeof url === "string" && url.trim())
      : typeof server.urls === "string" && server.urls.trim()
      ? [server.urls]
      : [];

    if (urls.length === 0) {
      continue;
    }

    const safeServer = { urls };
    if (typeof server.username === "string" && server.username) {
      safeServer.username = server.username;
    }
    if (typeof server.credential === "string" && server.credential) {
      safeServer.credential = server.credential;
    }
    normalized.push(safeServer);
  }

  return normalized.length > 0 ? normalized : [{ urls: "stun:stun.l.google.com:19302" }];
}

function pad(value) {
  return String(value).padStart(2, "0");
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

function setCallStatus(text) {
  callStatus.textContent = text;
}

function setConnectionStatus(text, isOnline) {
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle("is-online", Boolean(isOnline));
}

function renderSharingStatus() {
  const names = [...sharingPeers.values()];
  if (names.length === 0) {
    sharingStatus.textContent = "No one is sharing";
    return;
  }

  if (names.length === 1) {
    sharingStatus.textContent = `${names[0]} is sharing`;
    return;
  }

  sharingStatus.textContent = `${names.length} participants are sharing`;
}

function setScreenShareState(isSharing) {
  send("screen_share_state", { isSharing });
}

function updateCallControls() {
  const hasStream = Boolean(localStream);
  toggleMicBtn.disabled = !hasStream;
  toggleCamBtn.disabled = !hasStream || isScreenSharing;
  shareScreenBtn.disabled = !inCall || !hasStream;
  leaveCallBtn.disabled = !inCall && !hasStream;
  shareScreenBtn.textContent = isScreenSharing ? "Stop Sharing" : "Share Screen";
}

function shouldInitiateWith(peerId) {
  return Boolean(selfPeerId) && selfPeerId > peerId;
}

function getRemoteContainer(peerId, userName) {
  const containerId = `remote-${peerId}`;
  let container = document.getElementById(containerId);
  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.className = "video-tile";
  container.id = containerId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.dataset.peerId = peerId;

  const label = document.createElement("small");
  label.textContent = userName || "Peer";

  container.appendChild(video);
  container.appendChild(label);
  remoteVideos.appendChild(container);
  return container;
}

function removeRemoteContainer(peerId) {
  const container = document.getElementById(`remote-${peerId}`);
  if (container) {
    container.remove();
  }
}

function closePeerConnection(peerId) {
  const existing = peerConnections.get(peerId);
  if (!existing) {
    return;
  }

  existing.onicecandidate = null;
  existing.ontrack = null;
  existing.onconnectionstatechange = null;
  existing.close();
  peerConnections.delete(peerId);
  removeRemoteContainer(peerId);
}

function getActiveVideoTrack() {
  if (isScreenSharing && screenTrack) {
    return screenTrack;
  }
  if (cameraTrack) {
    return cameraTrack;
  }
  if (!localStream) {
    return null;
  }
  return localStream.getVideoTracks()[0] || null;
}

function replaceOutgoingVideoTrack(track) {
  for (const pc of peerConnections.values()) {
    const sender = pc.getSenders().find((entry) => entry.track && entry.track.kind === "video");
    if (sender) {
      sender.replaceTrack(track).catch(() => {});
    }
  }
}

function stopScreenShare() {
  if (!isScreenSharing) {
    return;
  }

  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
    screenTrack = null;
  }

  isScreenSharing = false;
  setScreenShareState(false);
  const fallbackTrack = getActiveVideoTrack();
  if (fallbackTrack) {
    replaceOutgoingVideoTrack(fallbackTrack);
  }
  if (localStream) {
    localVideo.srcObject = localStream;
  }
  updateCallControls();
}

function stopLocalMedia() {
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
    screenTrack = null;
  }

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }

  localStream = null;
  cameraTrack = null;
  isScreenSharing = false;
  localVideo.srcObject = null;
}

function leaveCallFlow() {
  if (isScreenSharing) {
    setScreenShareState(false);
  }
  inCall = false;
  resetAllPeers();
  stopLocalMedia();
  resetCallUi();
  updateCallControls();
}

async function ensureLocalMedia() {
  if (localStream) {
    return localStream;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
  cameraTrack = localStream.getVideoTracks()[0] || null;
  localVideo.srcObject = localStream;
  updateCallControls();
  return localStream;
}

function addTracksToConnection(pc) {
  if (!localStream) {
    return;
  }

  const senders = pc.getSenders();
  const mediaTracks = [...localStream.getAudioTracks()];
  const activeVideoTrack = getActiveVideoTrack();
  if (activeVideoTrack) {
    mediaTracks.push(activeVideoTrack);
  }

  for (const track of mediaTracks) {
    const alreadyAdded = senders.some((sender) => sender.track === track);
    if (!alreadyAdded) {
      pc.addTrack(track, localStream);
    }
  }
}

function getOrCreatePeerConnection(peerId, userName) {
  const existing = peerConnections.get(peerId);
  if (existing) {
    return existing;
  }

  const pc = new RTCPeerConnection({ iceServers: configuredIceServers });
  peerConnections.set(peerId, pc);
  addTracksToConnection(pc);

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    send("webrtc_ice", { to: peerId, candidate: event.candidate });
  };

  pc.ontrack = (event) => {
    const container = getRemoteContainer(peerId, userName || knownPeers.get(peerId) || "Peer");
    const video = container.querySelector("video");
    if (video && event.streams[0]) {
      video.srcObject = event.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      closePeerConnection(peerId);
    }
  };

  return pc;
}

async function createAndSendOffer(peerId) {
  const pc = getOrCreatePeerConnection(peerId, knownPeers.get(peerId));
  addTracksToConnection(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send("webrtc_offer", { to: peerId, sdp: pc.localDescription });
}

async function connectToKnownPeers() {
  if (!inCall) {
    return;
  }

  for (const [peerId] of knownPeers.entries()) {
    if (peerId === selfPeerId) {
      continue;
    }
    if (shouldInitiateWith(peerId) && !peerConnections.has(peerId)) {
      await createAndSendOffer(peerId);
    }
  }
}

async function startCallFlow() {
  try {
    await ensureLocalMedia();
    inCall = true;
    setCallStatus("Connected");
    startCallBtn.textContent = "In Call";
    startCallBtn.disabled = true;
    updateCallControls();
    await connectToKnownPeers();
  } catch {
    setCallStatus("Camera/Mic blocked");
    updateCallControls();
  }
}

function resetCallUi() {
  setCallStatus("Not connected");
  startCallBtn.textContent = "Start Call";
  startCallBtn.disabled = false;
  toggleMicBtn.textContent = "Mute Mic";
  toggleCamBtn.textContent = "Camera Off";
  updateCallControls();
}

function resetAllPeers() {
  for (const peerId of Array.from(peerConnections.keys())) {
    closePeerConnection(peerId);
  }
  remoteVideos.innerHTML = "";
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
    setConnectionStatus("Connected", true);
    send("join_room", { userName, roomId });
  });

  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "joined_ack") {
      selfPeerId = data.peerId;
      configuredIceServers = normalizeIceServers(data.iceServers);
      return;
    }

    if (data.type === "room_peers") {
      knownPeers.clear();
      for (const peer of data.peers || []) {
        knownPeers.set(peer.peerId, peer.userName || "Peer");
      }

      connectToKnownPeers().catch(() => {});
      return;
    }

    if (data.type === "screen_share_snapshot") {
      sharingPeers.clear();
      for (const peerId of data.sharers || []) {
        const name = knownPeers.get(peerId) || (peerId === selfPeerId ? "You" : "Peer");
        sharingPeers.set(peerId, name);
      }
      renderSharingStatus();
      return;
    }

    if (data.type === "screen_share_update") {
      if (data.isSharing) {
        sharingPeers.set(data.peerId, data.peerId === selfPeerId ? "You" : data.userName || "Peer");
      } else {
        sharingPeers.delete(data.peerId);
      }
      renderSharingStatus();
      return;
    }

    if (data.type === "peer_joined") {
      if (data.peerId && data.peerId !== selfPeerId) {
        knownPeers.set(data.peerId, data.userName || "Peer");
        if (inCall && shouldInitiateWith(data.peerId) && !peerConnections.has(data.peerId)) {
          createAndSendOffer(data.peerId).catch(() => {});
        }
      }
      return;
    }

    if (data.type === "peer_left") {
      if (data.peerId) {
        knownPeers.delete(data.peerId);
        closePeerConnection(data.peerId);
        sharingPeers.delete(data.peerId);
        renderSharingStatus();
      }
      return;
    }

    if (data.type === "webrtc_offer") {
      const fromPeerId = data.from;
      if (!fromPeerId) {
        return;
      }

      knownPeers.set(fromPeerId, data.userName || knownPeers.get(fromPeerId) || "Peer");

      ensureLocalMedia()
        .then(async () => {
          inCall = true;
          setCallStatus("Connected");
          startCallBtn.textContent = "In Call";
          startCallBtn.disabled = true;
          updateCallControls();

          const pc = getOrCreatePeerConnection(fromPeerId, knownPeers.get(fromPeerId));
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send("webrtc_answer", { to: fromPeerId, sdp: pc.localDescription });
        })
        .catch(() => {
          setCallStatus("Camera/Mic blocked");
          updateCallControls();
        });
      return;
    }

    if (data.type === "webrtc_answer") {
      const fromPeerId = data.from;
      const pc = peerConnections.get(fromPeerId);
      if (!pc || !data.sdp) {
        return;
      }
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(() => {});
      return;
    }

    if (data.type === "webrtc_ice") {
      const fromPeerId = data.from;
      const pc = peerConnections.get(fromPeerId);
      if (!pc || !data.candidate) {
        return;
      }
      pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
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
      userList.innerHTML = "";
      for (const user of data.users) {
        const li = document.createElement("li");
        li.textContent = user;
        userList.appendChild(li);
      }
    }
  });

  socket.addEventListener("close", () => {
    setConnectionStatus("Disconnected", false);
    appendMessage({
      author: "System",
      message: "Disconnected from server.",
      sentAt: new Date().toISOString(),
    });
    queueReconnect();
    leaveCallFlow();
  });

  socket.addEventListener("error", () => {
    setConnectionStatus("Connection issue", false);
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

loadRadioBtn.addEventListener("click", () => {
  const url = radioUrlInput.value.trim();
  if (!url) {
    return;
  }
  radioPlayer.src = url;
  radioPlayer.play().catch(() => {});
});

startCallBtn.addEventListener("click", () => {
  startCallFlow();
});

toggleMicBtn.addEventListener("click", () => {
  if (!localStream) {
    return;
  }

  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    return;
  }

  audioTrack.enabled = !audioTrack.enabled;
  toggleMicBtn.textContent = audioTrack.enabled ? "Mute Mic" : "Unmute Mic";
});

toggleCamBtn.addEventListener("click", () => {
  if (!localStream) {
    return;
  }

  const videoTrack = localStream.getVideoTracks()[0];
  const activeTrack = getActiveVideoTrack();
  if (!activeTrack) {
    return;
  }

  activeTrack.enabled = !activeTrack.enabled;
  toggleCamBtn.textContent = activeTrack.enabled ? "Camera Off" : "Camera On";
});

shareScreenBtn.addEventListener("click", async () => {
  if (!inCall || !navigator.mediaDevices?.getDisplayMedia) {
    return;
  }

  if (isScreenSharing) {
    stopScreenShare();
    return;
  }

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    const track = displayStream.getVideoTracks()[0];
    if (!track) {
      return;
    }

    isScreenSharing = true;
    screenTrack = track;
    localVideo.srcObject = displayStream;
    replaceOutgoingVideoTrack(track);
    setScreenShareState(true);

    track.onended = () => {
      stopScreenShare();
    };

    updateCallControls();
  } catch {
    setCallStatus("Screen share cancelled");
  }
});

leaveCallBtn.addEventListener("click", () => {
  leaveCallFlow();
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

setConnectionStatus("Ready", false);
renderSharingStatus();

window.addEventListener("online", () => {
  if (!joinedRoom) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setConnectionStatus("Reconnecting", false);
    connectWebSocket(currentUserName, currentRoomId);
  }
});

window.addEventListener("beforeunload", () => {
  leaveCallFlow();
});
