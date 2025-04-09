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

  socket.on('register', (data) => {
    const { userId } = data;
    users.set(userId, {
      socketId: socket.id,
      lastActive: new Date()
    });
    console.log('User registered:', userId);
  });

  socket.on('find_match', async (data) => {
    const { userId, preferences } = data;
    console.log('Finding match for:', userId, 'with preferences:', preferences);

    try {
      // Verify user exists and is online before adding to waiting list
      const { data: userProfile, error: userError } = await supabase
        .from('user_profiles')
        .select('id, is_online, preferred_gender, interests')
        .eq('id', userId)
        .single();

      if (userError) {
        console.error('Error fetching user profile:', userError);
        return;
      }

      if (!userProfile || !userProfile.is_online) {
        console.log('User not found or offline:', userId);
        return;
      }

      waitingUsers.set(userId, {
        socketId: socket.id,
        preferences: {
          ...preferences,
          userProfile
        },
        timestamp: new Date()
      });

      findMatch(userId);
    } catch (error) {
      console.error('Error in find_match handler:', error);
    }
  });

  socket.on('cancel_search', (userId) => {
    waitingUsers.delete(userId);
  });

  socket.on('send_message', (data) => {
    const { to, message } = data;
    const recipientSocket = users.get(to)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('receive_message', message);
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
    const recipientSocket = users.get(partnerId)?.socketId;
    if (recipientSocket) {
      io.to(recipientSocket).emit('chat_ended', { reason });
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, userData] of users.entries()) {
      if (userData.socketId === socket.id) {
        users.delete(userId);
        waitingUsers.delete(userId);
        break;
      }
    }
  });
});

async function findMatch(userId) {
  const currentUser = waitingUsers.get(userId);
  if (!currentUser) return;

  try {
    // Get current user's profile and preferences
    const { data: currentUserProfile, error: currentUserError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (currentUserError || !currentUserProfile || !currentUserProfile.is_online) {
      console.log('Current user not found or offline:', userId);
      waitingUsers.delete(userId);
      io.to(currentUser.socketId).emit('match_error', { message: 'User offline or not found' });
      return;
    }

    // Get potential matches
    const { data: potentialMatches, error: matchError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('is_online', true)
      .neq('id', userId)
      .not('reported_by', 'cs', `{${userId}}`);

    if (matchError) {
      console.error('Error fetching potential matches:', matchError);
      io.to(currentUser.socketId).emit('match_error', { message: 'Failed to find matches' });
      return;
    }

    if (!potentialMatches?.length) {
      console.log('No potential matches found for:', userId);
      io.to(currentUser.socketId).emit('match_error', { message: 'No matches available' });
      return;
    }

    // Filter matches based on preferences
    let filteredMatches = potentialMatches.filter(match => {
      // Check if user is already in a chat
      const isInChat = activeChats.has(match.id);
      if (isInChat) return false;

      // Check gender preference if specified
      if (currentUserProfile.preferred_gender && 
          currentUserProfile.preferred_gender !== 'any' && 
          match.gender !== currentUserProfile.preferred_gender) {
        return false;
      }

      // Check interests if specified
      if (currentUserProfile.interests?.length && 
          !currentUserProfile.interests.includes('any')) {
        return match.interests?.some(interest => 
          currentUserProfile.interests.includes(interest)
        );
      }

      return true;
    });

    if (!filteredMatches.length) {
      console.log('No suitable matches found for:', userId);
      io.to(currentUser.socketId).emit('match_error', { message: 'No suitable matches found' });
      return;
    }

    // Select random match
    const match = filteredMatches[Math.floor(Math.random() * filteredMatches.length)];

    // Create chat match in database
    const { error: chatError } = await supabase
      .from('chat_matches')
      .insert([{
        user1_id: userId,
        user2_id: match.id,
        status: 'active'
      }]);

    if (chatError) {
      console.error('Error creating chat match:', chatError);
      io.to(currentUser.socketId).emit('match_error', { message: 'Failed to create chat' });
      return;
    }

    // Add to active chats
    activeChats.set(userId, match.id);
    activeChats.set(match.id, userId);

    // Notify both users
    const matchUserSocket = users.get(match.id)?.socketId;

    io.to(currentUser.socketId).emit('match_found', { partnerId: match.id });
    if (matchUserSocket) {
      io.to(matchUserSocket).emit('match_found', { partnerId: userId });
    }

    // Remove from waiting list
    waitingUsers.delete(userId);
    waitingUsers.delete(match.id);

    console.log('Match created between:', userId, 'and', match.id);
  } catch (error) {
    console.error('Error in findMatch:', error);
    io.to(currentUser.socketId).emit('match_error', { message: 'Internal server error' });
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
