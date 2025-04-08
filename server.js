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
const waitingUsers = new Map(); // Eşleşme bekleyen kullanıcılar

// Test endpoint'i
app.get('/test', (req, res) => {
  res.json({ 
    status: 'Server is running',
    connections: connectionCount,
    activeUsers: Array.from(activeUsers.keys()),
    waitingUsers: Array.from(waitingUsers.keys()),
    timestamp: new Date().toISOString()
  });
});

io.on("connection", (socket) => {
  connectionCount++;
  console.error(`✅ Yeni kullanıcı bağlandı! Socket ID: ${socket.id}`);
  console.error(`📊 Toplam bağlı kullanıcı sayısı: ${connectionCount}`);

  socket.on("register", (data) => {
    const { userId, profile } = data;
    activeUsers.set(userId, { socketId: socket.id, profile });
    console.error(`👤 Kullanıcı kaydı: ${userId}`);
    console.error(`📊 Aktif kullanıcılar: ${Array.from(activeUsers.keys()).join(', ')}`);
  });

  socket.on("find_match", (data) => {
    const { userId, preferences } = data;
    console.error(`🔍 Eşleşme isteği:`, { userId, preferences });
    
    // Kullanıcıyı bekleme listesine ekle
    waitingUsers.set(userId, { socketId: socket.id, preferences });
    
    // Eşleşme arama durumunu bildir
    socket.emit('waiting_for_match');
    
    // Eşleşme kontrolü
    findMatch(userId);
  });

  socket.on("cancel_search", (userId) => {
    console.error(`❌ Eşleşme araması iptal edildi: ${userId}`);
    waitingUsers.delete(userId);
  });

  socket.on("disconnect", () => {
    connectionCount--;
    console.error(`❌ Kullanıcı ayrıldı: ${socket.id}`);
    console.error(`📊 Kalan bağlı kullanıcı sayısı: ${connectionCount}`);
    
    // Kullanıcıyı activeUsers ve waitingUsers'dan kaldır
    for (const [userId, userData] of activeUsers.entries()) {
      if (userData.socketId === socket.id) {
        activeUsers.delete(userId);
        waitingUsers.delete(userId);
        console.error(`👤 Kullanıcı çıkış yaptı: ${userId}`);
        console.error(`📊 Kalan aktif kullanıcılar: ${Array.from(activeUsers.keys()).join(', ')}`);
        break;
      }
    }
  });
});

// Eşleşme bulma fonksiyonu
function findMatch(userId) {
  const currentUser = waitingUsers.get(userId);
  if (!currentUser) return;

  // Tüm bekleyen kullanıcıları kontrol et
  for (const [otherUserId, otherUser] of waitingUsers.entries()) {
    if (otherUserId !== userId) {
      // Tercihleri kontrol et
      if (arePreferencesCompatible(currentUser.preferences, otherUser.preferences)) {
        // Eşleşme bulundu
        const match = {
          user1: {
            id: userId,
            socketId: currentUser.socketId,
            profile: activeUsers.get(userId).profile
          },
          user2: {
            id: otherUserId,
            socketId: otherUser.socketId,
            profile: activeUsers.get(otherUserId).profile
          }
        };

        // Her iki kullanıcıya da eşleşme bilgisini gönder
        io.to(currentUser.socketId).emit('match_found', match);
        io.to(otherUser.socketId).emit('match_found', match);

        // Kullanıcıları bekleme listesinden çıkar
        waitingUsers.delete(userId);
        waitingUsers.delete(otherUserId);

        console.error(`✨ Eşleşme bulundu: ${userId} ve ${otherUserId}`);
        break;
      }
    }
  }
}

// Tercihleri kontrol etme fonksiyonu
function arePreferencesCompatible(prefs1, prefs2) {
  // Basit bir eşleşme mantığı - geliştirilebilir
  return true; // Şimdilik tüm kullanıcıları eşleştir
}

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Tüm IP adreslerinden erişime izin ver

server.listen(PORT, HOST, () => {
  console.error(`🚀 Sunucu ${HOST}:${PORT} adresinde çalışıyor`);
  console.error(`🌐 Yerel IP: http://192.168.1.103:${PORT}`);
  console.error(`📊 Başlangıçta bağlı kullanıcı sayısı: ${connectionCount}`);
});
