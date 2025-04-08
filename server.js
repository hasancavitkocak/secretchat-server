const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Netlify'den gelen istekler için
    methods: ["GET", "POST"]
  }
});

let waitingUsers = [];

io.on("connection", (socket) => {
  console.log("✅ Kullanıcı bağlandı:", socket.id);

  socket.on("find_partner", () => {
    console.log("🔍 Eşleşme aranıyor:", socket.id);

    if (waitingUsers.length > 0) {
      const partnerId = waitingUsers.pop();

      const roomId = `${socket.id}#${partnerId}`;
      socket.join(roomId);
      io.sockets.sockets.get(partnerId)?.join(roomId);

      io.to(socket.id).emit("partner_found", { roomId });
      io.to(partnerId).emit("partner_found", { roomId });

      console.log(`💬 Eşleşme tamamlandı! Oda: ${roomId}`);
    } else {
      waitingUsers.push(socket.id);
      console.log("⏳ Beklemeye alındı:", socket.id);
    }
  });

  socket.on("disconnect", () => {
    waitingUsers = waitingUsers.filter(id => id !== socket.id);
    console.log("❌ Kullanıcı ayrıldı:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("🚀 Sunucu 3000 portunda çalışıyor");
});
