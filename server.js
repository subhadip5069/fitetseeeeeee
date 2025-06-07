const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const fs = require('fs');
const io = require('socket.io');
const path = require('path');
const dotenv = require('dotenv');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

const rooms = new Map();

let server;
if (process.env.NODE_ENV === 'production') {
  const sslOptions = {
    key: fs.readFileSync(process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/sampledemo.shop/privkey.pem'),
    cert: fs.readFileSync(process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/sampledemo.shop/fullchain.pem')
  };
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

const socketIo = io(server);

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/join', (req, res) => {
  res.render('join', { error: null });
});

app.post('/join', (req, res) => {
  const { email, code } = req.body;
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return res.render('join', { error: 'Invalid email format' });
  }
  if (!code.match(/^[0-9]{6}$/)) {
    return res.render('join', { error: 'Invalid code: Must be a 6-digit number' });
  }
  res.redirect(`/join/${encodeURIComponent(email)}/${code}`);
});

app.get('/join/:email/:code', (req, res) => {
  const { email, code } = req.params;
  if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return res.status(400).render('join', { error: 'Invalid email format' });
  }
  if (!code.match(/^[0-9]{6}$/)) {
    return res.status(400).render('join', { error: 'Invalid code: Must be a 6-digit number' });
  }
  res.render('meeting', { email, code });
});

app.get('/api/ice-servers', async (req, res) => {
  try {
    const response = await fetch("https://global.xirsys.net/_turn/MyFirstApp", {
      method: "PUT",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${process.env.XIRSYS_USERNAME}:${process.env.XIRSYS_SECRET}`).toString('base64'),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ format: "urls" })
    });
    const data = await response.json();
    res.json({ iceServers: data.v.iceServers });
    logger.info('ICE servers fetched successfully');
  } catch (err) {
    logger.error('Error fetching ICE servers:', err);
    res.status(500).json({ error: 'Failed to fetch ICE servers' });
  }
});

socketIo.on('connection', (socket) => {
  logger.info(`New connection: ${socket.id}`);

  socket.on('join-room', ({ roomId, email }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const room = rooms.get(roomId);
    if (room.size >= 200) {
      socket.emit('room-full');
      logger.warn(`Room ${roomId} full`);
      return;
    }
    room.add(socket.id);
    socket.join(roomId);
    socket.email = sanitizeHtml(email);

    const participants = Array.from(room).map(id => ({
      id,
      email: socketIo.sockets.sockets.get(id)?.email || 'Unknown',
      camera: true,
      mic: true
    }));
    socket.emit('existing-participants', participants.filter(p => p.id !== socket.id));
    socket.to(roomId).emit('user-connected', { id: socket.id, email: socket.email });
    logger.info(`${socket.email} joined room ${roomId}`);

    socket.on('offer', ({ sdp, target, initiator }) => {
      socket.to(target).emit('offer', { sdp, callerId: initiator, callerEmail: socket.email });
    });

    socket.on('answer', ({ sdp, target, initiator }) => {
      socket.to(target).emit('answer', { sdp, callerId: initiator });
    });

    socket.on('ice-candidate', ({ candidate, target, initiator }) => {
      socket.to(target).emit('ice-candidate', { candidate, callerId: initiator });
    });

    socket.on('toggle-camera', (camera) => {
      socket.to(roomId).emit('participant-status', { id: socket.id, camera, mic: socket.mic ?? true });
      socket.camera = camera;
    });

    socket.on('toggle-mic', (mic) => {
      socket.to(roomId).emit('participant-status', { id: socket.id, camera: socket.camera ?? true, mic });
      socket.mic = mic;
    });

    socket.on('chat-message', (message) => {
      const cleanMessage = sanitizeHtml(message, { allowedTags: [] });
      socket.to(roomId).emit('chat-message', { email: socket.email, message: cleanMessage });
      socket.emit('chat-message', { email: socket.email, message: cleanMessage });
    });

    socket.on('reaction', (emoji) => {
      socket.to(roomId).emit('reaction', { email: socket.email, emoji });
      socket.emit('reaction', { email: socket.email, emoji });
    });

    socket.on('disconnect', () => {
      room.delete(socket.id);
      if (room.size === 0) {
        rooms.delete(roomId);
      }
      socket.to(roomId).emit('user-disconnected', socket.id);
      logger.info(`${socket.email} disconnected from room ${roomId}`);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});