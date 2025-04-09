import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Supabase client
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
  transports: ['websocket', 'polling']
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
      currentUserId = userId;

      // Verify user exists
      const { data: user, error } = await supabase
        .from('user_profiles')
        .select('id, is_online')
        .eq('id', userId)
        .single();

      if (error || !user) {
        callback({ error: 'User not found' });
        return;
      }

      // Store socket information
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
      
      if (!users.has(userId)) {
        callback({ error: 'User not registered' });
        return;
      }

      // Check if user is already in a chat
      if (activeChats.has(userId)) {
        callback({ error: 'User already in chat' });
        return;
      }

      // Add to waiting list
      waitingUsers.set(userId, {
        socketId: socket.id,
        preferences,
        timestamp: new Date()
      });

      callback({ success: true });
      
      // Try to find a match
      await findMatch(userId);
    } catch (error) {
      console.error('Find match error:', error);
      callback({ error: 'Failed to start matching' });
    }
  });

  socket.on('cancel_search', (data, callback) => {
    try {
      const { userId } = data;
      waitingUsers.delete(userId);
      callback({ success: true });
    } catch (error) {
      callback({ error: 'Failed to cancel search' });
    }
  });

  socket.on('send_message', (data, callback) => {
    try {
      const { to, message } = data;
      const recipientSocket = users.get(to)?.socketId;
      
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive_message', message);
        callback({ success: true });
      } else {
        callback({ error: 'Recipient not found' });
      }
    } catch (error) {
      callback({ error: 'Failed to send message' });
    }
  });

  socket.on('typing', (data) => {
    const { partnerId, isTyping } = data;
    const recipientSocket = users.get(partnerId)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('partner_typing', isTyping);
    }
  });

  socket.on('end_chat', (data) => {
    const { partnerId, reason } = data;
    
    // Remove from active chats
    if (currentUserId) {
      activeChats.delete(currentUserId);
      activeChats.delete(partnerId);
    }

    const recipientSocket = users.get(partnerId)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('chat_ended', { reason });
    }
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      users.delete(currentUserId);
      waitingUsers.delete(currentUserId);
      activeChats.delete(currentUserId);
    }
  });
});

async function findMatch(userId) {
  const currentUser = waitingUsers.get(userId);
  if (!currentUser) return;

  try {
    // Get current user's profile
    const { data: currentUserProfile, error: currentUserError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (currentUserError || !currentUserProfile) {
      throw new Error('Current user not found');
    }

    // Get potential matches
    const { data: potentialMatches, error: matchError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('is_online', true)
      .neq('id', userId)
      .not('reported_by', 'cs', `{${userId}}`);

    if (matchError || !potentialMatches?.length) {
      throw new Error('No potential matches found');
    }

    // Filter matches
    const filteredMatches = potentialMatches.filter(match => {
      // Skip users already in chat or waiting
      if (activeChats.has(match.id) || waitingUsers.has(match.id)) {
        return false;
      }

      // Check gender preference
      if (currentUser.preferences?.preferred_gender && 
          currentUser.preferences.preferred_gender !== 'any' && 
          match.gender !== currentUser.preferences.preferred_gender) {
        return false;
      }

      // Check interests
      if (currentUser.preferences?.interests?.length && 
          !currentUser.preferences.interests.includes('any')) {
        return match.interests?.some(interest => 
          currentUser.preferences.interests.includes(interest)
        );
      }

      return true;
    });

    if (!filteredMatches.length) {
      throw new Error('No suitable matches found');
    }

    // Select random match
    const match = filteredMatches[Math.floor(Math.random() * filteredMatches.length)];
    const matchSocket = users.get(match.id)?.socketId;

    if (!matchSocket) {
      throw new Error('Selected match is offline');
    }

    // Create chat match
    const { error: chatError } = await supabase
      .from('chat_matches')
      .insert([{
        user1_id: userId,
        user2_id: match.id,
        status: 'active'
      }]);

    if (chatError) {
      throw new Error('Failed to create chat match');
    }

    // Add to active chats
    activeChats.set(userId, match.id);
    activeChats.set(match.id, userId);

    // Remove from waiting list
    waitingUsers.delete(userId);
    waitingUsers.delete(match.id);

    // Notify both users
    io.to(currentUser.socketId).emit('match_found', { partnerId: match.id });
    io.to(matchSocket).emit('match_found', { partnerId: userId });

    console.log('Match created between:', userId, 'and', match.id);
  } catch (error) {
    console.error('Error in findMatch:', error);
    const userSocket = users.get(userId)?.socketId;
    if (userSocket) {
      io.to(userSocket).emit('match_error', { message: error.message });
    }
    waitingUsers.delete(userId);
  }
}

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
