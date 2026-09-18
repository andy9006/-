// server.js
// 你畫我猜小遊戲 - 伺服器端 (v2：支援自訂房間設定 + 最終排名結算)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 3 * 1024 * 1024, // 放寬到 3MB，讓背景圖片可以順利傳送
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- 隨機題庫（可自行增減） ----------
const WORD_LIST = [
  "蘋果", "香蕉", "西瓜", "貓咪", "狗狗", "大象", "長頸鹿", "企鵝",
  "太陽", "月亮", "彩虹", "雨傘", "腳踏車", "汽車", "飛機", "火車",
  "披薩", "漢堡", "蛋糕", "冰淇淋", "電腦", "手機", "眼鏡", "帽子",
  "足球", "籃球", "游泳", "吉他", "鋼琴", "聖誕樹", "雪人", "城堡",
  "機器人", "恐龍", "美人魚", "海盜", "忍者", "超人", "魔法師", "蝴蝶"
];

const ALLOWED_DRAW_SECONDS = [10, 30, 60];
const MAX_RANDOM_ROUNDS = 20;
const MAX_CUSTOM_WORDS = 30;
const MAX_BG_IMAGE_CHARS = 2_500_000; // 粗略上限，避免記憶體爆掉

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 記憶體中的房間資料 ----------
const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function publicPlayerList(room) {
  return room.order
    .filter((id) => room.players.has(id))
    .map((id) => ({
      id,
      name: room.players.get(id).name,
      score: room.players.get(id).score,
      isDrawer: id === room.drawerId,
      isHost: id === room.hostId,
    }));
}

function broadcastPlayers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("players", publicPlayerList(room));
}

function maskWord(word) {
  return Array.from(word).map(() => "＿").join(" ");
}

function buildWordQueue(room) {
  if (room.wordMode === "custom") {
    return room.customWords.slice(0, room.totalRounds);
  }
  let pool = shuffle(WORD_LIST);
  const queue = [];
  while (queue.length < room.totalRounds) {
    if (pool.length === 0) pool = shuffle(WORD_LIST);
    queue.push(pool.pop());
  }
  return queue;
}

function roomInfoPayload(room) {
  return {
    roomName: room.roomName,
    hostOnlyDraws: room.hostOnlyDraws,
    drawSeconds: room.drawSeconds,
    totalRounds: room.totalRounds,
    backgroundImage: room.backgroundImage,
    hostId: room.hostId,
  };
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.timer) clearInterval(room.timer);
  room.roundActive = false;
  room.gameOver = true;
  room.drawerId = null;

  const rankings = publicPlayerList(room)
    .map((p) => ({ name: p.name, score: p.score, id: p.id }))
    .sort((a, b) => b.score - a.score);

  io.to(roomCode).emit("gameOver", { rankings, hostId: room.hostId });
}

function endRound(roomCode, reason) {
  const room = rooms[roomCode];
  if (!room || !room.roundActive) return;
  room.roundActive = false;
  if (room.timer) clearInterval(room.timer);

  io.to(roomCode).emit("roundEnd", { reason, word: room.currentWord });

  setTimeout(() => startNextRound(roomCode), 2500);
}

function startNextRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.gameOver) return;

  room.order = room.order.filter((id) => room.players.has(id));

  if (room.hostOnlyDraws) {
    if (!room.players.has(room.hostId)) {
      endGame(roomCode);
      return;
    }
    if (room.order.length < 2) {
      io.to(roomCode).emit("waitingForPlayers");
      return;
    }
  } else if (room.order.length < 2) {
    io.to(roomCode).emit("waitingForPlayers");
    return;
  }

  room.roundNumber += 1;
  if (room.roundNumber > room.totalRounds) {
    endGame(roomCode);
    return;
  }

  if (room.hostOnlyDraws) {
    room.drawerId = room.hostId;
  } else {
    room.drawerIndex = (room.drawerIndex + 1) % room.order.length;
    room.drawerId = room.order[room.drawerIndex];
  }

  room.currentWord = room.wordQueue[room.roundNumber - 1];
  room.strokes = [];
  room.correctGuessers = new Set();
  room.roundActive = true;
  room.timeLeft = room.drawSeconds;

  const drawerName = room.players.get(room.drawerId).name;
  const common = {
    drawerName,
    seconds: room.drawSeconds,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
  };

  io.to(room.drawerId).emit("roundStart", { ...common, isDrawer: true, word: room.currentWord });
  room.order.forEach((id) => {
    if (id === room.drawerId) return;
    io.to(id).emit("roundStart", { ...common, isDrawer: false, wordMask: maskWord(room.currentWord) });
  });

  broadcastPlayers(roomCode);

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomCode).emit("tick", room.timeLeft);
    if (room.timeLeft <= 0) endRound(roomCode, "timeUp");
  }, 1000);
}

function startFreshGame(roomCode, resetScores) {
  const room = rooms[roomCode];
  if (!room) return;
  room.wordQueue = buildWordQueue(room);
  room.roundNumber = 0;
  room.drawerIndex = -1;
  room.drawerId = null;
  room.gameOver = false;
  if (resetScores) {
    room.players.forEach((p) => (p.score = 0));
  }
  startNextRound(roomCode);
}

io.on("connection", (socket) => {
  // ---- 建立房間（含自訂設定） ----
  socket.on("createRoom", (payload = {}) => {
    const roomCode = genRoomCode();

    let drawSeconds = parseInt(payload.drawSeconds, 10);
    if (!ALLOWED_DRAW_SECONDS.includes(drawSeconds)) drawSeconds = 30;

    let wordMode = payload.wordMode === "custom" ? "custom" : "random";
    let customWords = [];
    let totalRounds = 5;

    if (wordMode === "custom") {
      customWords = Array.isArray(payload.customWords)
        ? payload.customWords.map((w) => String(w).trim()).filter(Boolean).slice(0, MAX_CUSTOM_WORDS)
        : [];
      if (customWords.length === 0) {
        socket.emit("errorMsg", "自訂詞彙不能是空的，請至少輸入一個詞。");
        return;
      }
      totalRounds = customWords.length;
    } else {
      totalRounds = parseInt(payload.totalRounds, 10);
      if (!Number.isFinite(totalRounds) || totalRounds < 1) totalRounds = 5;
      if (totalRounds > MAX_RANDOM_ROUNDS) totalRounds = MAX_RANDOM_ROUNDS;
    }

    let backgroundImage = null;
    if (typeof payload.backgroundImage === "string" && payload.backgroundImage.startsWith("data:image")) {
      if (payload.backgroundImage.length <= MAX_BG_IMAGE_CHARS) {
        backgroundImage = payload.backgroundImage;
      }
    }

    const roomName = (payload.roomName || "").toString().trim().slice(0, 24) || "你畫我猜遊戲房";

    rooms[roomCode] = {
      players: new Map(),
      order: [],
      hostId: null,
      hostOnlyDraws: !!payload.hostOnlyDraws,
      roomName,
      drawSeconds,
      wordMode,
      customWords,
      totalRounds,
      wordQueue: [],
      backgroundImage,
      roundNumber: 0,
      drawerIndex: -1,
      drawerId: null,
      currentWord: null,
      strokes: [],
      correctGuessers: new Set(),
      roundActive: false,
      gameOver: false,
      timer: null,
      timeLeft: 0,
    };

    joinRoom(socket, roomCode, payload.name || "房主", true);
  });

  // ---- 加入房間 ----
  socket.on("joinRoom", ({ room, name }) => {
    const roomCode = (room || "").toUpperCase().trim();
    if (!rooms[roomCode]) {
      socket.emit("errorMsg", "找不到這個房間，請確認房號或重新掃描 QR Code。");
      return;
    }
    joinRoom(socket, roomCode, name || "玩家", false);
  });

  function joinRoom(socket, roomCode, name, isCreator) {
    const room = rooms[roomCode];
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    room.players.set(socket.id, { name: String(name).slice(0, 12), score: 0 });
    room.order.push(socket.id);
    if (isCreator) room.hostId = socket.id;

    let gameOverPayload = null;
    if (room.gameOver) {
      const rankings = publicPlayerList(room).map((p) => ({ name: p.name, score: p.score, id: p.id }))
        .sort((a, b) => b.score - a.score);
      gameOverPayload = { rankings, hostId: room.hostId };
    }

    socket.emit("joined", {
      roomCode,
      selfId: socket.id,
      strokes: room.strokes,
      currentDrawerId: room.drawerId,
      wordMask: room.currentWord && room.roundActive ? maskWord(room.currentWord) : null,
      roundActive: room.roundActive,
      timeLeft: room.timeLeft,
      roundNumber: room.roundNumber,
      roomInfo: roomInfoPayload(room),
      gameOverPayload,
    });

    io.to(roomCode).emit("systemMsg", `${name} 加入了房間`);
    broadcastPlayers(roomCode);

    if (room.order.length >= 2 && !room.roundActive && !room.gameOver && room.roundNumber === 0) {
      startFreshGame(roomCode, false);
    }
  }

  // ---- 畫布同步 ----
  socket.on("draw", (data) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.drawerId) return;
    room.strokes.push(data);
    socket.to(socket.data.roomCode).emit("draw", data);
  });

  socket.on("clearCanvas", () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.drawerId) return;
    room.strokes = [];
    socket.to(socket.data.roomCode).emit("clearCanvas");
  });

  // ---- 搶答 ----
  socket.on("guess", (text) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;
    if (socket.id === room.drawerId) return;
    if (room.correctGuessers.has(socket.id)) return;

    const guesserName = room.players.get(socket.id)?.name || "玩家";
    const clean = (text || "").trim();
    if (!clean) return;

    const isCorrect = clean === room.currentWord;
    if (!isCorrect) {
      io.to(roomCode).emit("chatMsg", { name: guesserName, text: clean, correct: false });
      return;
    }

    room.correctGuessers.add(socket.id);
    const rank = room.correctGuessers.size;
    const points = Math.max(10 - (rank - 1) * 2, 2);
    const player = room.players.get(socket.id);
    player.score += points;

    const drawer = room.players.get(room.drawerId);
    if (drawer) drawer.score += 2;

    io.to(roomCode).emit("chatMsg", { name: guesserName, text: "答對了！", correct: true });
    io.to(roomCode).emit("correctGuess", { name: guesserName, rank, points });
    broadcastPlayers(roomCode);

    const totalGuessers = room.order.length - 1;
    if (room.correctGuessers.size >= totalGuessers) {
      endRound(roomCode, "allCorrect");
    }
  });

  // ---- 房主再玩一輪 ----
  socket.on("playAgain", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (!room.gameOver) return;
    startFreshGame(roomCode, true);
  });

  // ---- 離線處理 ----
  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const wasDrawer = socket.id === room.drawerId;
    const name = room.players.get(socket.id)?.name;
    room.players.delete(socket.id);
    room.order = room.order.filter((id) => id !== socket.id);

    if (name) io.to(roomCode).emit("systemMsg", `${name} 離開了房間`);
    broadcastPlayers(roomCode);

    if (room.order.length === 0) {
      if (room.timer) clearInterval(room.timer);
      delete rooms[roomCode];
      return;
    }

    if (room.hostOnlyDraws && socket.id === room.hostId && room.roundActive) {
      endGame(roomCode);
      return;
    }

    if (wasDrawer && room.roundActive) {
      endRound(roomCode, "notEnoughPlayers");
    } else if (room.order.length < 2 && room.roundActive === false && !room.gameOver) {
      io.to(roomCode).emit("waitingForPlayers");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`伺服器已啟動：http://localhost:${PORT}`);
});
