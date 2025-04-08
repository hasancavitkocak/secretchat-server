const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

// CORS ayarlarını güncelle - tüm IP'lere izin ver
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
}));

const server = http.createServer(app);

// Socket.IO ayarlarını güncelle - tüm IP'lere izin ver
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Bağlantı sayacı ve aktif kullanıcılar
let connectionCount = 0;
const activeUsers = new Map();

// Test endpoint'i
app.get('/test', (req, res) => {
  res.json({ 
    status: 'Server is running',
    connections: connectionCount,
    activeUsers: Array.from(activeUsers.keys()),
    timestamp: new Date().toISOString()
  });
});

io.on("connection", (socket) => {
  connectionCount++;
  console.error(`✅ Yeni kullanıcı bağlandı! Socket ID: ${socket.id}`);
  console.error(`📊 Toplam bağlı kullanıcı sayısı: ${connectionCount}`);

  socket.on("register", (userId) => {
    activeUsers.set(userId, socket.id);
    console.error(`👤 Kullanıcı kaydı: ${userId}`);
    console.error(`📊 Aktif kullanıcılar: ${Array.from(activeUsers.keys()).join(', ')}`);
  });

  socket.on("find_match", (data) => {
    const { userId, preferences } = data;
    console.error(`🔍 Eşleşme isteği:`, { userId, preferences });
  });

  socket.on("disconnect", () => {
    connectionCount--;
    console.error(`❌ Kullanıcı ayrıldı: ${socket.id}`);
    console.error(`📊 Kalan bağlı kullanıcı sayısı: ${connectionCount}`);
    
    // Kullanıcıyı activeUsers'dan kaldır
    for (const [userId, socketId] of activeUsers.entries()) {
      if (socketId === socket.id) {
        activeUsers.delete(userId);
        console.error(`👤 Kullanıcı çıkış yaptı: ${userId}`);
        console.error(`📊 Kalan aktif kullanıcılar: ${Array.from(activeUsers.keys()).join(', ')}`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Tüm IP adreslerinden erişime izin ver

server.listen(PORT, HOST, () => {
  console.error(`🚀 Sunucu ${HOST}:${PORT} adresinde çalışıyor`);
  console.error(`🌐 Yerel IP: http://192.168.1.103:${PORT}`);
  console.error(`📊 Başlangıçta bağlı kullanıcı sayısı: ${connectionCount}`);
});
