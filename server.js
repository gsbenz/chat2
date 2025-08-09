const http = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// State
const rooms = new Map(); // Map<roomName, Set<WebSocket>>
const typingUsers = {};  // { roomName: Set<username> }

// ===== Helper Functions =====

// Safe JSON parse
const parseJSON = (msg) => {
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
};

// Send message to single client
const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

// Validate fields and send error if missing
const requireFields = (ws, data, ...fields) => {
  const missing = fields.filter(f => typeof data[f] !== 'string' || !data[f].trim());
  if (missing.length) {
    send(ws, { type: 'error', message: `Missing or invalid fields: ${missing.join(', ')}` });
    return false;
  }
  return true;
};

// Broadcast to a room (optionally excluding sender)
const broadcastToRoom = (room, payload, excludeWs = null) => {
  if (!rooms.has(room)) return;
  const msg = JSON.stringify(payload);
  for (const client of rooms.get(room)) {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(msg);
    }
  }
};

// Update presence list for a room
const broadcastPresence = (room) => {
  if (!rooms.has(room)) return;
  const users = [...rooms.get(room)]
    .map(c => c.username)
    .filter(Boolean);
  broadcastToRoom(room, { type: 'presence', room, users });
};

// ===== Room Logic =====

const joinRoom = (ws, room) => {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.rooms.add(room);

  broadcastToRoom(room, { type: 'user_joined', room, sender: ws.username }, ws);
  send(ws, { type: 'system', content: `Joined room: ${room}` });
  broadcastPresence(room);
};

const leaveRoom = (ws, room) => {
  if (rooms.has(room)) {
    rooms.get(room).delete(ws);
    if (rooms.get(room).size === 0) rooms.delete(room);
  }
  ws.rooms.delete(room);

  // Remove from typing list
  if (typingUsers[room]) {
    typingUsers[room].delete(ws.username);
    if (typingUsers[room].size === 0) {
      delete typingUsers[room];
    } else {
      broadcastToRoom(room, {
        type: 'typing',
        room,
        typingUsers: Array.from(typingUsers[room])
      });
    }
  }

  broadcastToRoom(room, { type: 'user_left', room, sender: ws.username }, ws);
  send(ws, { type: 'system', content: `Left room: ${room}` });
  broadcastPresence(room);
};

// ===== Message Handlers =====

const messageHandlers = {
  join: (ws, data) => {
    if (requireFields(ws, data, 'room', 'sender')) {
      ws.username = data.sender;
      joinRoom(ws, data.room);
    }
  },

  leave: (ws, data) => {
    if (requireFields(ws, data, 'room')) {
      leaveRoom(ws, data.room);
    }
  },

  message: (ws, data) => {
    if (requireFields(ws, data, 'room', 'content') && ws.rooms.has(data.room)) {
      broadcastToRoom(data.room, {
        type: 'message',
        room: data.room,
        sender: ws.username,
        content: data.content,
        timestamp: data.timestamp || Date.now(),
        reply: data.reply || null
      });
    }
  },

  reaction: (ws, data) => {
    if (requireFields(ws, data, 'room', 'target', 'emoji') && ws.rooms.has(data.room)) {
      broadcastToRoom(data.room, {
        type: 'reaction',
        room: data.room,
        sender: ws.username,
        target: data.target,
        emoji: data.emoji,
        timestamp: data.timestamp || Date.now()
      });
    }
  },

  presence_request: (ws, data) => {
    if (requireFields(ws, data, 'room') && ws.rooms.has(data.room)) {
      broadcastPresence(data.room);
    }
  },

  typing: (ws, data) => {
    if (!requireFields(ws, data, 'room')) return;
    const room = data.room;
    const user = ws.username;
    if (!user || !ws.rooms.has(room)) return;

    if (!typingUsers[room]) typingUsers[room] = new Set();
    data.typing ? typingUsers[room].add(user) : typingUsers[room].delete(user);

    broadcastToRoom(room, {
      type: 'typing',
      room,
      typingUsers: Array.from(typingUsers[room])
    });
  }
};

// ===== WebSocket Connection =====

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.username = null;

  ws.on('message', (msg) => {
    const data = parseJSON(msg);
    if (!data) return send(ws, { type: 'error', message: 'Invalid JSON' });

    const handler = messageHandlers[data.type];
    if (handler) {
      handler(ws, data);
    } else {
      send(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
    }
  });

  ws.on('close', () => {
    for (const room of ws.rooms) {
      leaveRoom(ws, room);
    }
  });
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WebSocket server running on port ${PORT}`));
