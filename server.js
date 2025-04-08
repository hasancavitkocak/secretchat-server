const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Netlify domainini buraya yazabilirsin
    methods: ["GET", "POST"]
  }
});

// Basit kullanıcı kuyruğu
let waitingUsers = [];

io.on("connection", (socket) => {
  console.log("✅ Kullanıcı bağlandı:", socket.id);

  // Kullanıcıyı kaydetmek istersen
  socket.on("register", (userId) => {
    console.log(`🪪 Kullanıcı kaydoldu: ${userId} (${socket.id})`);
    socket.data.userId = userId;
  });

  // Eşleşme isteği
  socket.on("find_match", ({ userId, preferences }) => {
    console.log("🔍 Eşleşme aranıyor:", userId, socket.id, preferences);

    if (waitingUsers.length > 0) {
      const partnerSocket = waitingUsers.pop();

      const roomId = `${socket.id}#${partnerSocket.id}`;

      socket.join(roomId);
      partnerSocket.join(roomId);

      socket.emit("partner_found", { roomId });
      partnerSocket.emit("partner_found", { roomId });

      console.log(`💬 Eşleşme tamamlandı! Oda: ${roomId}`);
    } else {
      // Beklemeye al
      waitingUsers.push(socket);
      console.log("⏳ Beklemeye alındı:", userId);
    }
  });

  // Eşleşme iptali
  socket.on("cancel_search", (userId) => {
    waitingUsers = waitingUsers.filter(s => s.id !== socket.id);
    console.log("❌ Eşleşme iptal edildi:", userId);
  });

  // Mesaj gönderme
  socket.on("send_message", ({ to, message }) => {
    console.log(`📩 Mesaj gönderiliyor: ${socket.id} → ${to}`, message);
    io.to(to).emit("receive_message", {
      from: socket.id,
      message,
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ Kullanıcı ayrıldı:", socket.id);
    waitingUsers = waitingUsers.filter(s => s.id !== socket.id);
  });
});

// Test için:
app.get("/", (req, res) => {
  res.send("✅ Secret Chat Socket.IO server is running.");
});

server.listen(3000, () => {
  console.log("🚀 Sunucu 3000 portunda çalışıyor");
});
