// server.js
// 你畫我猜小遊戲 - 伺服器端
// 負責：房間管理 / 畫布同步廣播 / 搶答順序判定 / 計分 / 回合輪替

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---------- 題庫（可自行增減） ----------
const WORD_LIST = [
  "蘋果", "香蕉", "西瓜", "貓咪", "狗狗", "大象", "長頸鹿", "企鵝",
  "太陽", "月亮", "彩虹", "雨傘", "腳踏車", "汽車", "飛機", "火車",
  "披薩", "漢堡", "蛋糕", "冰淇淋", "電腦", "手機", "眼鏡", "帽子",
  "足球", "籃球", "游泳", "吉他", "鋼琴", "聖誕樹", "雪人", "城堡",
  "機器人", "恐龍", "美人魚", "海盜", "忍者", "超人", "魔法師", "蝴蝶"
];

const ROUND_SECONDS = 70; // 每回合秒數

// ---------- 記憶體中的房間資料 ----------
// rooms[roomCode] = {
//   players: Map(socketId -> {name, score}),
//   order: [socketId, ...],          // 輪流畫圖的順序
//   drawerIndex: 0,
//   drawerId: null,
//   currentWord: null,
//   strokes: [],                     // 目前這一畫的所有筆畫，供新加入者補畫面
//   correctGuessers: Set(),
//   roundActive: false,
//   timer: null,
//   timeLeft: 0
// }
const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去除易混淆字元
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
    }));
}

function broadcastPlayers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("players", publicPlayerList(room));
}

function maskWord(word) {
  // 給非畫圖者看的提示：顯示字數，例如 "＿＿＿"
  return Array.from(word).map(() => "＿").join(" ");
}

function endRound(roomCode, reason) {
  const room = rooms[roomCode];
  if (!room || !room.roundActive) return;
  room.roundActive = false;
  if (room.timer) clearInterval(room.timer);

  io.to(roomCode).emit("roundEnd", {
    reason, // "allCorrect" | "timeUp" | "notEnoughPlayers"
    word: room.currentWord,
  });

  // 3 秒後自動開始下一回合（若人數足夠）
  setTimeout(() => startNextRound(roomCode), 3000);
}

function startNextRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // 移除已離線的玩家
  room.order = room.order.filter((id) => room.players.has(id));

  if (room.order.length < 2) {
    io.to(roomCode).emit("waitingForPlayers");
    return;
  }

  room.drawerIndex = (room.drawerIndex + 1) % room.order.length;
  room.drawerId = room.order[room.drawerIndex];
  room.currentWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
  room.strokes = [];
  room.correctGuessers = new Set();
  room.roundActive = true;
  room.timeLeft = ROUND_SECONDS;

  const drawerName = room.players.get(room.drawerId).name;

  // 畫圖者收到完整題目，其他人只收到字數提示
  io.to(room.drawerId).emit("roundStart", {
    isDrawer: true,
    word: room.currentWord,
    drawerName,
    seconds: ROUND_SECONDS,
  });
  room.order.forEach((id) => {
    if (id === room.drawerId) return;
    io.to(id).emit("roundStart", {
      isDrawer: false,
      wordMask: maskWord(room.currentWord),
      drawerName,
      seconds: ROUND_SECONDS,
    });
  });

  broadcastPlayers(roomCode);

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(roomCode).emit("tick", room.timeLeft);
    if (room.timeLeft <= 0) {
      endRound(roomCode, "timeUp");
    }
  }, 1000);
}

io.on("connection", (socket) => {
  // ---- 建立房間 ----
  socket.on("createRoom", (name) => {
    const roomCode = genRoomCode();
    rooms[roomCode] = {
      players: new Map(),
      order: [],
      drawerIndex: -1,
      drawerId: null,
      currentWord: null,
      strokes: [],
      correctGuessers: new Set(),
      roundActive: false,
      timer: null,
      timeLeft: 0,
    };
    joinRoom(socket, roomCode, name || "房主");
  });

  // ---- 加入房間 ----
  socket.on("joinRoom", ({ room, name }) => {
    const roomCode = (room || "").toUpperCase().trim();
    if (!rooms[roomCode]) {
      socket.emit("errorMsg", "找不到這個房間，請確認房號或重新掃描 QR Code。");
      return;
    }
    joinRoom(socket, roomCode, name || "玩家");
  });

  function joinRoom(socket, roomCode, name) {
    const room = rooms[roomCode];
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    room.players.set(socket.id, { name: name.slice(0, 12), score: 0 });
    room.order.push(socket.id);

    socket.emit("joined", {
      roomCode,
      selfId: socket.id,
      strokes: room.strokes,
      currentDrawerId: room.drawerId,
      wordMask: room.currentWord ? maskWord(room.currentWord) : null,
      roundActive: room.roundActive,
      timeLeft: room.timeLeft,
    });

    io.to(roomCode).emit("systemMsg", `${name} 加入了房間`);
    broadcastPlayers(roomCode);

    // 已經有 2 人以上且目前沒有進行中的回合 -> 開始遊戲
    if (room.order.length >= 2 && !room.roundActive) {
      startNextRound(roomCode);
    }
  }

  // ---- 畫布同步 ----
  socket.on("draw", (data) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.drawerId) return; // 只有畫圖者能畫
    room.strokes.push(data);
    socket.to(roomCode).emit("draw", data);
  });

  socket.on("clearCanvas", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.drawerId) return;
    room.strokes = [];
    socket.to(roomCode).emit("clearCanvas");
  });

  // ---- 搶答 ----
  socket.on("guess", (text) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.roundActive) return;
    if (socket.id === room.drawerId) return; // 畫圖者不能自己猜
    if (room.correctGuessers.has(socket.id)) return; // 已經答對過

    const guesserName = room.players.get(socket.id)?.name || "玩家";
    const clean = (text || "").trim();
    if (!clean) return;

    const isCorrect = clean === room.currentWord;

    if (!isCorrect) {
      // 一般聊天/錯誤猜測也廣播出去，增加互動感
      io.to(roomCode).emit("chatMsg", { name: guesserName, text: clean, correct: false });
      return;
    }

    // ---- 答對：依「伺服器收到的先後順序」計分，公平且不可作弊 ----
    room.correctGuessers.add(socket.id);
    const rank = room.correctGuessers.size; // 第幾個答對
    const points = Math.max(10 - (rank - 1) * 2, 2);
    const player = room.players.get(socket.id);
    player.score += points;

    // 畫圖者也給一點鼓勵分數
    const drawer = room.players.get(room.drawerId);
    if (drawer) drawer.score += 2;

    io.to(roomCode).emit("chatMsg", { name: guesserName, text: "答對了！", correct: true });
    io.to(roomCode).emit("correctGuess", { name: guesserName, rank, points });
    broadcastPlayers(roomCode);

    const totalGuessers = room.order.length - 1; // 扣掉畫圖者
    if (room.correctGuessers.size >= totalGuessers) {
      endRound(roomCode, "allCorrect");
    }
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

    if (wasDrawer && room.roundActive) {
      endRound(roomCode, "notEnoughPlayers");
    } else if (room.order.length < 2) {
      if (room.timer) clearInterval(room.timer);
      room.roundActive = false;
      io.to(roomCode).emit("waitingForPlayers");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`伺服器已啟動：http://localhost:${PORT}`);
});
