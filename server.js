import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enhanced CORS configuration
const corsOptions = {
  origin: '*', // Allow all origins in development
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('dist'));

const server = createServer(app);

// Improved Socket.IO configuration
const io = new Server(server, {
  cors: corsOptions,
  transports: ['polling', 'websocket'], // Start with polling, upgrade to websocket
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e8
});

// In-memory storage
const users = new Map();
const waitingUsers = new Map();
const connections = new Set();

// Utility function for logging
const log = (message, data = {}) => {
  console.log(`[${new Date().toISOString()}] ${message}`, data);
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  log('New connection established', { socketId: socket.id });
  connections.add(socket.id);

  // Handle user registration
  socket.on('register', (data) => {
    try {
      const { userId } = data;
      log('User registered', { userId, socketId: socket.id });
      
      users.set(userId, {
        socketId: socket.id,
        lastActive: new Date()
      });
      
      socket.emit('registration_successful', { userId });
    } catch (error) {
      log('Registration error', { error: error.message });
      socket.emit('error', { message: 'Registration failed' });
    }
  });

  // Handle match finding
  socket.on('find_match', (data) => {
    try {
      const { userId, preferences } = data;
      log('Match request received', { userId, preferences });

      waitingUsers.set(userId, {
        socketId: socket.id,
        preferences,
        timestamp: new Date()
      });

      socket.emit('searching');
      findMatch(userId);
    } catch (error) {
      log('Match finding error', { error: error.message });
      socket.emit('error', { message: 'Match finding failed' });
    }
  });

  // Handle search cancellation
  socket.on('cancel_search', (userId) => {
    try {
      log('Search cancelled', { userId });
      waitingUsers.delete(userId);
      socket.emit('search_cancelled');
    } catch (error) {
      log('Cancel search error', { error: error.message });
      socket.emit('error', { message: 'Failed to cancel search' });
    }
  });

  // Handle message sending
  socket.on('send_message', (data) => {
    try {
      const { to, message } = data;
      const recipientSocket = users.get(to)?.socketId;
      
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive_message', message);
        log('Message sent', { to, from: socket.id });
      }
    } catch (error) {
      log('Message sending error', { error: error.message });
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    try {
      connections.delete(socket.id);
      
      // Remove user from users and waiting lists
      for (const [userId, userData] of users.entries()) {
        if (userData.socketId === socket.id) {
          users.delete(userId);
          waitingUsers.delete(userId);
          log('User disconnected', { userId });
          break;
        }
      }
    } catch (error) {
      log('Disconnect error', { error: error.message });
    }
  });
});

// Match finding logic
function findMatch(userId) {
  const currentUser = waitingUsers.get(userId);
  if (!currentUser) return;

  const potentialMatches = Array.from(waitingUsers.entries())
    .filter(([id]) => id !== userId)
    .sort(() => Math.random() - 0.5);

  for (const [matchId, matchData] of potentialMatches) {
    const match = {
      user1: userId,
      user2: matchId
    };

    // Notify both users
    io.to(currentUser.socketId).emit('match_found', {
      partnerId: matchId
    });
    
    io.to(matchData.socketId).emit('match_found', {
      partnerId: userId
    });

    // Remove both users from waiting list
    waitingUsers.delete(userId);
    waitingUsers.delete(matchId);

    log('Match created', match);
    break;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    connections: connections.size,
    users: users.size,
    waiting: waitingUsers.size
  });
});

// Handle React Router routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log(`Server running on port ${PORT}`);
});
