import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(express.static('dist'));

const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// In-memory storage
const users = new Map();
const waitingUsers = new Map();
const activeChats = new Map();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  let currentUserId = null;

  socket.on('register', async (data, callback) => {
    try {
      const { userId } = data;
      if (!userId) {
        callback({ error: 'User ID is required' });
        return;
      }

      currentUserId = userId;
      users.set(userId, {
        socketId: socket.id,
        lastActive: new Date()
      });

      callback({ success: true });
      console.log('User registered:', userId);
    } catch (error) {
      console.error('Registration error:', error);
      callback({ error: 'Registration failed' });
    }
  });

  socket.on('find_match', async (data, callback) => {
    try {
      const { userId, preferences } = data;
      
      if (!userId) {
        callback({ error: 'User ID is required' });
        return;
      }

      if (!users.has(userId)) {
        callback({ error: 'User not registered' });
        return;
      }

      if (activeChats.has(userId)) {
        callback({ error: 'Already in chat' });
        return;
      }

      // Add to waiting list
      waitingUsers.set(userId, {
        socketId: socket.id,
        preferences,
        timestamp: new Date()
      });

      callback({ success: true });
      
      // Find match for user
      findMatch(userId);
    } catch (error) {
      console.error('Find match error:', error);
      callback({ error: 'Failed to start matching' });
    }
  });

  socket.on('cancel_search', (data, callback) => {
    try {
      const { userId } = data;
      if (!userId) {
        callback({ error: 'User ID is required' });
        return;
      }

      waitingUsers.delete(userId);
      callback({ success: true });
    } catch (error) {
      callback({ error: 'Failed to cancel search' });
    }
  });

  socket.on('send_message', (data, callback) => {
    try {
      const { to, message } = data;
      if (!to || !message) {
        callback({ error: 'Invalid message data' });
        return;
      }

      const recipientSocket = users.get(to)?.socketId;
      if (!recipientSocket) {
        callback({ error: 'Recipient not found' });
        return;
      }

      io.to(recipientSocket).emit('receive_message', message);
      callback({ success: true });
    } catch (error) {
      callback({ error: 'Failed to send message' });
    }
  });

  socket.on('typing', (data) => {
    const { partnerId, isTyping } = data;
    if (!partnerId) return;

    const recipientSocket = users.get(partnerId)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('partner_typing', isTyping);
    }
  });

  socket.on('end_chat', (data) => {
    const { partnerId, reason } = data;
    if (!partnerId || !currentUserId) return;
    
    // Remove from active chats
    activeChats.delete(currentUserId);
    activeChats.delete(partnerId);

    const recipientSocket = users.get(partnerId)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('chat_ended', { reason });
    }
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      console.log('User disconnected:', currentUserId);
      users.delete(currentUserId);
      waitingUsers.delete(currentUserId);
      
      // Notify chat partner if in active chat
      const partnerId = activeChats.get(currentUserId);
      if (partnerId) {
        const partnerSocket = users.get(partnerId)?.socketId;
        if (partnerSocket) {
          io.to(partnerSocket).emit('chat_ended', { reason: 'disconnected' });
        }
        activeChats.delete(currentUserId);
        activeChats.delete(partnerId);
      }
    }
  });
});

function findMatch(userId) {
  const currentUser = waitingUsers.get(userId);
  if (!currentUser) return;

  // Get all waiting users except current user
  const potentialMatches = Array.from(waitingUsers.entries())
    .filter(([id]) => id !== userId)
    .map(([id, data]) => ({ id, ...data }));

  if (potentialMatches.length === 0) {
    return;
  }

  // Find suitable match based on preferences
  const match = potentialMatches.find(match => {
    // Skip users already in chat
    if (activeChats.has(match.id)) {
      return false;
    }

    // Check gender preferences if specified
    if (currentUser.preferences?.preferred_gender && 
        currentUser.preferences.preferred_gender !== 'any') {
      // Skip if no match
      if (!match.preferences?.gender || 
          match.preferences.gender !== currentUser.preferences.preferred_gender) {
        return false;
      }
    }

    // Check interests if specified
    if (currentUser.preferences?.interests?.length && 
        !currentUser.preferences.interests.includes('any')) {
      // Skip if no common interests
      if (!match.preferences?.interests?.some(interest => 
        currentUser.preferences.interests.includes(interest)
      )) {
        return false;
      }
    }

    return true;
  });

  if (!match) {
    return;
  }

  // Create the match
  activeChats.set(userId, match.id);
  activeChats.set(match.id, userId);

  // Remove both users from waiting list
  waitingUsers.delete(userId);
  waitingUsers.delete(match.id);

  // Notify both users
  io.to(currentUser.socketId).emit('match_found', { partnerId: match.id });
  io.to(match.socketId).emit('match_found', { partnerId: userId });

  console.log('Match created between:', userId, 'and', match.id);
}

// API Routes
app.get('/api/stats', (req, res) => {
  res.json({
    totalUsers: users.size,
    activeConnections: io.engine.clientsCount,
    totalMessages: 0, // Implement message counting if needed
    activeChatRooms: activeChats.size / 2 // Divide by 2 as each chat is counted twice
  });
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
