const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ejs = require('ejs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/join/:email/:code', (req, res) => {
  const { email, code } = req.params;
  res.render('meeting', { email, code });
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  socket.on('join-room', ({ roomId, email }) => {
    socket.join(roomId);
    socket.data.email = email;
    const participants = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .filter(id => id !== socket.id)
      .map(id => ({ id, email: io.sockets.sockets.get(id).data.email }));
    socket.emit('existing-participants', participants);
    socket.to(roomId).emit('user-connected', { id: socket.id, email });
  });

  socket.on('offer', ({ sdp, target, sender }) => {
    socket.to(target).emit('offer', { sdp, callerId: sender, callerEmail: socket.data.email });
  });

  socket.on('answer', ({ sdp, target, sender }) => {
    socket.to(target).emit('answer', { sdp, callerId: sender });
  });

  socket.on('ice-candidate', ({ candidate, target, sender }) => {
    socket.to(target).emit('ice-candidate', { candidate, callerId: sender });
  });

  socket.on('chat-message', ({ message, target }) => {
    if (target === 'group') {
      socket.to(socket.rooms.values().next().value).emit('chat-message', { email: socket.data.email, message });
      socket.emit('chat-message', { email: socket.data.email, message });
    } else {
      socket.to(target).emit('chat-message', { email: socket.data.email, message });
      socket.emit('chat-message', { email: socket.data.email, message });
    }
  });

  socket.on('emoji', ({ emoji, target }) => {
    if (target === 'group') {
      socket.to(socket.rooms.values().next().value).emit('emoji', { email: socket.data.email, emoji });
      socket.emit('emoji', { email: socket.data.email, emoji });
    } else {
      socket.to(target).emit('emoji', { email: socket.data.email, emoji });
      socket.emit('emoji', { email: socket.data.email, emoji });
    }
  });

  socket.on('hand-raise', () => {
    socket.to(socket.rooms.values().next().value).emit('hand-raise', { email: socket.data.email });
  });

  socket.on('disconnect', () => {
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.to(room).emit('user-disconnected', socket.id);
      }
    });
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
