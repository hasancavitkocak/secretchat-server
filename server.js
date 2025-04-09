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
      return;
    }

    // Get potential matches
    const { data: potentialMatches, error: matchError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('is_online', true)
      .neq('id', userId)
      .not('reported_by', 'cs', `{${userId}}`)
      .not('id', 'in', `(
        SELECT user2_id FROM chat_matches 
        WHERE user1_id = '${userId}' AND status != 'ended'
        UNION
        SELECT user1_id FROM chat_matches 
        WHERE user2_id = '${userId}' AND status != 'ended'
      )`);

    if (matchError) {
      console.error('Error fetching potential matches:', matchError);
      return;
    }

    if (!potentialMatches?.length) {
      console.log('No potential matches found for:', userId);
      return;
    }

    // Filter matches based on preferences
    let filteredMatches = potentialMatches;
    const userPrefs = currentUser.preferences;

    if (userPrefs.preferred_gender && userPrefs.preferred_gender !== 'any') {
      filteredMatches = filteredMatches.filter(match => 
        match.gender === userPrefs.preferred_gender
      );
    }

    if (userPrefs.interests?.length && !userPrefs.interests.includes('any')) {
      filteredMatches = filteredMatches.filter(match =>
        match.interests?.some(interest => userPrefs.interests.includes(interest))
      );
    }

    // Select random match from filtered list
    const match = filteredMatches[Math.floor(Math.random() * filteredMatches.length)];
    
    if (!match) {
      console.log('No suitable match found for:', userId);
      return;
    }

    // Create match in database
    const { error: matchCreateError } = await supabase
      .from('chat_matches')
      .insert([{
        user1_id: userId,
        user2_id: match.id,
        status: 'active'
      }]);

    if (matchCreateError) {
      console.error('Error creating match:', matchCreateError);
      return;
    }

    // Notify both users
    const currentUserSocket = currentUser.socketId;
    const matchUserSocket = users.get(match.id)?.socketId;

    if (currentUserSocket) {
      io.to(currentUserSocket).emit('match_found', {
        partnerId: match.id
      });
    }

    if (matchUserSocket) {
      io.to(matchUserSocket).emit('match_found', {
        partnerId: userId
      });
    }

    // Remove both users from waiting list
    waitingUsers.delete(userId);
    waitingUsers.delete(match.id);

    console.log('Match created between:', userId, 'and', match.id);
  } catch (error) {
    console.error('Error in findMatch:', error);
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
