const socket = io();
let localStream;
let peerConnections = {};
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let rotationAngle = 0;
let unreadMessages = 0;
let mainStream = null;
let mainStreamId = 'local';
let handRaised = false;

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

async function startMeeting(roomId, email) {
  console.log(`Starting meeting for ${email} in room ${roomId}`);
  socket.emit('join-room', { roomId, email });

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
      audio: true
    });
    mainStream = localStream;
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.onloadedmetadata = () => {
      localVideo.play().catch(err => console.error('Local video play error:', err));
      console.log('Local video loaded and playing');
    };
    addParticipant('local', email, localStream);
  } catch (err) {
    console.error('Error accessing media devices:', err);
    alert(`Failed to access camera and microphone: ${err.message}. Please check permissions.`);
    return;
  }

  socket.on('existing-participants', (participants) => {
    console.log('Existing participants:', participants);
    participants.forEach(({ id, email }) => {
      createPeerConnection(id, email, roomId, true);
    });
  });

  socket.on('user-connected', ({ id, email }) => {
    console.log(`User connected: ${email} (${id})`);
    createPeerConnection(id, email, roomId, false);
  });

  socket.on('offer', async ({ sdp, callerId, callerEmail }) => {
    console.log(`Received offer from ${callerId} (${callerEmail})`);
    await createPeerConnection(callerId, callerEmail, roomId, false);
    const peerConnection = peerConnections[callerId].peerConnection;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { sdp: answer, target: callerId, sender: socket.id });
      console.log(`Sent answer to ${callerId}`);
    } catch (err) {
      console.error(`Error handling offer from ${callerId}:`, err);
    }
  });

  socket.on('answer', async ({ sdp, callerId }) => {
    console.log(`Received answer from ${callerId}`);
    const peerConnection = peerConnections[callerId]?.peerConnection;
    if (peerConnection) {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log(`Set remote description for ${callerId}`);
        while (peerConnections[callerId].iceCandidates.length > 0) {
          const candidate = peerConnections[callerId].iceCandidates.shift();
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`Applied buffered ICE candidate for ${callerId}`);
        }
      } catch (err) {
        console.error(`Error handling answer from ${callerId}:`, err);
      }
    }
  });

  socket.on('ice-candidate', async ({ candidate, callerId }) => {
    console.log(`Received ICE candidate from ${callerId}`);
    const peerConnection = peerConnections[callerId]?.peerConnection;
    if (peerConnection) {
      try {
        if (candidate) {
          if (peerConnection.remoteDescription) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`Added ICE candidate from ${callerId}`);
          } else {
            peerConnections[callerId].iceCandidates.push(candidate);
            console.log(`Buffered ICE candidate from ${callerId}`);
          }
        }
      } catch (err) {
        console.error(`Error adding ICE candidate from ${callerId}:`, err);
      }
    }
  });

  socket.on('user-disconnected', (id) => {
    console.log(`User disconnected: ${id}`);
    if (peerConnections[id]) {
      peerConnections[id].peerConnection.close();
      if (mainStreamId === id) {
        mainStream = localStream;
        mainStreamId = 'local';
        document.getElementById('local-video').srcObject = localStream;
        updateSelectedVideo('local');
      }
      document.getElementById(`container-${id}`)?.remove();
      delete peerConnections[id];
      updateChatTargetOptions();
    }
  });

  socket.on('chat-message', ({ email, message }) => {
    const chatContainer = document.getElementById('chat-container');
    const chatPanel = document.getElementById('chat-panel');
    const chatBadge = document.getElementById('chat-badge');
    const messageElement = document.createElement('p');
    messageElement.textContent = `${email}: ${message}`;
    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    if (!chatPanel.classList.contains('active')) {
      unreadMessages++;
      chatBadge.textContent = unreadMessages;
      chatBadge.parentElement.classList.add('has-messages');
    }
  });

  socket.on('emoji', ({ email, emoji }) => {
    const emojiContainer = document.getElementById('emoji-container');
    const emojiElement = document.createElement('div');
    emojiElement.className = 'emoji';
    emojiElement.textContent = `${email}: ${emoji}`;
    emojiContainer.appendChild(emojiElement);
    setTimeout(() => emojiElement.remove(), 3000);
  });

  socket.on('hand-raise', ({ email }) => {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = `${email} raised their hand`;
    document.getElementById('notifications').appendChild(notification);
    setTimeout(() => notification.remove(), 5000);
  });
}

async function createPeerConnection(id, email, roomId, initiateOffer) {
  if (peerConnections[id]) {
    console.log(`Peer connection for ${id} already exists`);
    return;
  }

  const peerConnection = new RTCPeerConnection(configuration);
  peerConnections[id] = { peerConnection, email, stream: null, iceCandidates: [] };

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
    console.log(`Added ${track.kind} track to peer ${id}`);
  });

  peerConnection.ontrack = (event) => {
    console.log(`Received track from ${id}: ${event.track.kind}`);
    if (!peerConnections[id].stream) {
      peerConnections[id].stream = new MediaStream();
    }
    peerConnections[id].stream.addTrack(event.track);
    addParticipant(id, email, peerConnections[id].stream);
    if (event.track.kind === 'video') {
      const remoteVideo = document.getElementById(`video-${id}`);
      if (remoteVideo) {
        remoteVideo.srcObject = peerConnections[id].stream;
        remoteVideo.play().catch(err => console.error(`Error playing video for ${id}:`, err));
      }
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { candidate: event.candidate, target: id, sender: socket.id });
      console.log(`Sent ICE candidate to ${id}`);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log(`ICE connection state for ${id}: ${peerConnection.iceConnectionState}, signaling state: ${peerConnection.signalingState}`);
    if (peerConnection.iceConnectionState === 'failed') {
      peerConnection.restartIce();
      console.log(`Restarted ICE for ${id}`);
    }
  };

  if (initiateOffer) {
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { sdp: offer, target: id, sender: socket.id });
      console.log(`Sent offer to ${id}`);
    } catch (err) {
      console.error(`Error creating offer for ${id}:`, err);
    }
  }

  updateChatTargetOptions();
}

function addParticipant(id, email, stream) {
  const participants = document.getElementById('participants');
  let videoContainer = document.getElementById(`container-${id}`);
  if (!videoContainer) {
    videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `container-${id}`;
    const video = document.createElement('video');
    video.id = `video-${id}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = id === 'local';
    video.srcObject = stream;
    videoContainer.appendChild(video);
    const nameLabel = document.createElement('p');
    nameLabel.textContent = email;
    videoContainer.appendChild(nameLabel);
    videoContainer.onclick = () => swapVideo(id);
    participants.appendChild(videoContainer);
    video.play().catch(err => console.error(`Error playing video for ${id}:`, err));
    console.log(`Added participant ${id} (${email}) to UI`);
  } else {
    const video = document.getElementById(`video-${id}`);
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(err => console.error(`Error playing video for ${id}:`, err));
      console.log(`Updated stream for ${id} (${email})`);
    }
  }
}

function swapVideo(id) {
  const mainVideo = document.getElementById('local-video');
  const newStream = id === 'local' ? localStream : peerConnections[id]?.stream;
  if (!newStream) {
    console.warn(`No stream found for ${id}`);
    return;
  }
  mainVideo.srcObject = newStream;
  mainStream = newStream;
  mainStreamId = id;
  mainVideo.play().catch(err => console.error(`Error playing main video for ${id}:`, err));
  updateSelectedVideo(id);
  console.log(`Swapped main video to ${id}`);
}

function updateSelectedVideo(id) {
  document.querySelectorAll('.video-container').forEach(container => {
    container.classList.remove('selected');
  });
  const selectedContainer = document.getElementById(`container-${id}`);
  if (selectedContainer) {
    selectedContainer.classList.add('selected');
  }
}

function updateChatTargetOptions() {
  const chatTarget = document.getElementById('chat-target');
  chatTarget.innerHTML = '<option value="group">Group</option>';
  Object.values(peerConnections).forEach(({ email, peerConnection }) => {
    const option = document.createElement('option');
    option.value = peerConnection.id;
    option.textContent = email;
    chatTarget.appendChild(option);
  });
}

function toggleVideo() {
  const enabled = localStream.getVideoTracks()[0].enabled;
  localStream.getVideoTracks()[0].enabled = !enabled;
  const btn = document.getElementById('video-btn');
  btn.classList.toggle('off', !enabled);
  btn.querySelector('i').classList.toggle('fa-video', enabled);
  btn.querySelector('i').classList.toggle('fa-video-slash', !enabled);
  console.log(`Video toggled: ${!enabled ? 'on' : 'off'}`);
}

function toggleAudio() {
  const enabled = localStream.getAudioTracks()[0].enabled;
  localStream.getAudioTracks()[0].enabled = !enabled;
  const btn = document.getElementById('audio-btn');
  btn.classList.toggle('off', !enabled);
  btn.querySelector('i').classList.toggle('fa-microphone', enabled);
  btn.querySelector('i').classList.toggle('fa-microphone-slash', !enabled);
  console.log(`Audio toggled: ${!enabled ? 'on' : 'off'}`);
}

function rotateCamera() {
  rotationAngle = (rotationAngle + 90) % 360;
  document.getElementById('local-video').style.transform = `rotate(${rotationAngle}deg)`;
  console.log(`Rotated camera to ${rotationAngle}deg`);
}

async function shareScreen() {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    Object.values(peerConnections).forEach(({ peerConnection }) => {
      const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
      sender.replaceTrack(screenTrack);
    });
    if (mainStreamId === 'local') {
      mainStream = screenStream;
      document.getElementById('local-video').srcObject = screenStream;
    }
    screenTrack.onended = () => {
      Object.values(peerConnections).forEach(({ peerConnection }) => {
        const videoTrack = localStream.getVideoTracks()[0];
        peerConnection.getSenders().find(s => s.track.kind === 'video').replaceTrack(videoTrack);
      });
      if (mainStreamId === 'local') {
        mainStream = localStream;
        document.getElementById('local-video').srcObject = localStream;
      }
    };
    console.log('Started screen sharing');
  } catch (err) {
    console.error('Error sharing screen:', err);
  }
}

function toggleRecording() {
  if (!isRecording) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1280;
    canvas.height = 720;
    const streams = [mainStream, ...Object.values(peerConnections).map(p => p.stream)].filter(s => s);
    let xOffset = 0;
    const videos = streams.map(stream => {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.autoplay = true;
      return video;
    });
    function draw() {
      xOffset = 0;
      videos.forEach(video => {
        ctx.drawImage(video, xOffset, 0, canvas.width / videos.length, canvas.height);
        xOffset += canvas.width / videos.length;
      });
      requestAnimationFrame(draw);
    }
    videos.forEach(video => {
      video.onloadedmetadata = () => draw();
    });
    const canvasStream = canvas.captureStream();
    mediaRecorder = new MediaRecorder(canvasStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fitetse-meet-${new Date().toISOString()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      recordedChunks = [];
    };
    mediaRecorder.start();
    isRecording = true;
    document.getElementById('record-btn').classList.add('off');
    console.log('Started recording');
  } else {
    mediaRecorder.stop();
    isRecording = false;
    document.getElementById('record-btn').classList.remove('off');
    console.log('Stopped recording');
  }
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const target = document.getElementById('chat-target').value;
  const message = input.value.trim();
  if (message) {
    socket.emit('chat-message', { message, target });
    input.value = '';
    console.log(`Sent message to ${target}`);
  }
}

function sendEmoji(emoji) {
  const target = document.getElementById('chat-target').value;
  socket.emit('emoji', { emoji, target });
  console.log(`Sent emoji ${emoji} to ${target}`);
}

function toggleHandRaise() {
  handRaised = !handRaised;
  const btn = document.getElementById('hand-btn');
  btn.classList.toggle('off', !handRaised);
  if (handRaised) {
    socket.emit('hand-raise');
    console.log('Raised hand');
  }
}

function hangup() {
  localStream?.getTracks().forEach(track => track.stop());
  Object.values(peerConnections).forEach(({ peerConnection }) => peerConnection.close());
  socket.disconnect();
  window.location.href = '/';
  console.log('Hung up');
}

function toggleChat() {
  const chatPanel = document.getElementById('chat-panel');
  const chatBadge = document.getElementById('chat-badge');
  chatPanel.classList.toggle('active');
  if (chatPanel.classList.contains('active')) {
    unreadMessages = 0;
    chatBadge.textContent = '0';
    chatBadge.parentElement.classList.remove('has-messages');
  }
  console.log(`Chat panel ${chatPanel.classList.contains('active') ? 'opened' : 'closed'}`);
}

function toggleControls() {
  const controls = document.getElementById('controls');
  controls.classList.toggle('active');
  console.log(`Controls ${controls.classList.contains('active') ? 'shown' : 'hidden'}`);
}

function toggleTheme() {
  document.body.classList.toggle('light-mode');
  console.log(`Toggled to ${document.body.classList.contains('light-mode') ? 'light' : 'dark'} mode`);
}
