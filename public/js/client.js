const socket = io();
let localStream;
let peerConnections = {};
let rotationAngle = 0;
let unreadMessages = 0;
let bigScreenIds = [];
let cycleInterval = null;
let participants = [];

const getIceServers = async () => {
  try {
    const res = await fetch("/api/ice-servers", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    return data.iceServers;
  } catch (err) {
    console.error('Error fetching ICE servers:', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
};

async function startMeeting(roomId, email) {
  console.log(`Starting meeting for ${email} in room ${roomId}`);
  socket.emit('join-room', { roomId, email });

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 360, frameRate: 15 },
      audio: true
    });
    const localVideo = document.getElementById('video-local');
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.autoplay = true;
    localStream.getVideoTracks().forEach(track => track.enabled = true);
    localStream.getAudioTracks().forEach(track => track.enabled = true);
    document.getElementById('local-label').textContent = `${email} (You)`;
    console.log('Local stream initialized');

    participants.push({ id: socket.id, email, camera: true, mic: true });
    addParticipantToList(socket.id, email, true, true, true);
    addToBigScreen(socket.id);
  } catch (err) {
    console.error('Error accessing media devices:', err);
    alert('Failed to access camera/microphone. Please check permissions.');
    return false;
  }

  const meetingContainer = document.querySelector('.meeting-container');
  const controls = document.querySelector('.controls');
  let hideTimeout;
  meetingContainer.addEventListener('mouseenter', () => {
    controls.style.opacity = '1';
    clearTimeout(hideTimeout);
  });
  meetingContainer.addEventListener('mouseleave', () => {
    hideTimeout = setTimeout(() => {
      controls.style.opacity = '0';
    }, 3000);
  });

  socket.on('existing-participants', (existingParticipants) => {
    console.log('Existing participants:', existingParticipants);
    existingParticipants.forEach(({ id, email, camera, mic }) => {
      if (id !== socket.id) {
        createPeerConnection(id, email, roomId, true);
        participants.push({ id, email, camera, mic });
        addParticipantToList(id, email, camera, mic, false);
      }
    });
    updateBigScreenCycle();
  });

  socket.on('user-connected', ({ id, email }) => {
    console.log(`User connected: ${email} (socket ${id})`);
    createPeerConnection(id, email, roomId, false);
    participants.push({ id, email, camera: true, mic: true });
    addParticipantToList(id, email, true, true, false);
    updateBigScreenCycle();
  });

  socket.on('offer', async ({ sdp, callerId, callerEmail }) => {
    console.log(`Received offer from ${callerId} (${callerEmail})`);
    await createPeerConnection(callerId, callerEmail, roomId, false);
    const peerConnection = peerConnections[callerId].peerConnection;
    try {
      await peerConnection.signalingState !== 'closed' && await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('answer', { sdp: answer, target: callerId, initiator: socket.id });
      console.log(`Sent answer to ${callerId}`);
    } catch (err) {
      console.error(`Error handling offer from ${callerId}:`, err);
    }
  });

  socket.on('answer', async ({ sdp, callerId }) => {
    console.log(`Received answer from ${callerId}`);
    console.log('answered:', callerId);
    const peerConnection = peerConnections[callerId]?.peerConnection;
    if (peerConnection && peerConnection.signalingState !== 'closed') {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log(`Set remote description for ${callerId}`);
      } catch (err) {
        console.error(`Error handling answer from ${callerId}:`, err);
      }
    }
  });

  socket.on('ice-candidate', async ({ candidate, callerId }) => {
    console.log(`Received ICE candidate from ${callerId}`);
    const peerConnection = peerConnections[callerId]?.peerConnection;
    if (peerConnection && peerConnection.connectionState !== 'closed') {
      try {
        if (candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`Added ICE candidate from ${callerId}`);
        }
      } catch (err) {
        console.error(`Error adding ICE candidate from ${callerId}:`, err);
      }
    }
  });

  socket.on('user-disconnected', (id) => {
    console.log(`User disconnected: ${id}`);
    if (peerConnections[id]) {
      peerConnections[id].peerConnection(id).close();
      delete peerConnections[id];
    }
    participants = participants.filter(p => p.id !== p.id);
    const participantItem = document.getElementById(`participant-${id}`);
    if (participantItem) participantItem.removeChild();
    bigScreenIds = bigScreenIds.filter(bigId => bigId !== id);
    updateBigScreen();
    updateBigScreenCycle();
  });

  socket.on('chat-message', ({ email, message }) => {
    console.log(`Chat message from ${email}: ${message}`);
    const chatContainer = document.getElementById('chat-container');
    const chatPanel = document.getElementById('chat-panel');
    const chatBadge = document.getElementById('#chatBadge');
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

  socket.on('reaction', ({ email, emoji }) => {
    console.log(`Reaction from ${emoji}: ${email}`);
    displayReaction(emoji);
  });

  socket.on('participant-status', ({ id, camera, mic }) => {
    console.log(`Status update for ${id}: camera=${camera}, mic=${mic}`);
    const participant = participants.find(p => p.id === id);
    if (participant) {
      participant.camera = camera;
      participant.mic = mic;
      updateParticipantStatus(id, camera, mic);
    }
  });

  socket.on('room-full', () => {
    alert('Room is full (200 participants limit reached).');
    window.location.href = '/';
    }
  );

  document.addEventListener('click', (event) => {
    const moreMenu = document.getElementById('more-menu');
    const moreBtn = document.getElementById('more-btn');
    const reactionPicker = document.getElementById('reaction-panel');
    const reactionBtn = document.getElementById('reaction-menu');
    if (moreMenu && !moreMenu.contains(event.target) && !moreBtn.contains(event.target)) {
      moreMenu.style.display = 'none';
    }
    if (reactionPicker && !reactionPicker.contains(event.target) && !reactionBtn.contains(event.target)) {
      reactionPicker.style.display = 'none';
    }
  });
}

async function createPeerConnection(id, email, roomId, initiateOffer) {
  if (peerConnections[id]) return;

  const iceServers = await getIceServers();
  const peerConnection = new RTCPeerConnection({ iceServers });
  peerConnections[id] = { peerConnection, email, stream: null };

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
    if (event.track.kind === 'audio') {
      event.track.enabled = true;
    }
    if (bigScreenIds.includes(id)) {
      updateBigScreen();
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { candidate: event.candidate, target: id, initiator: socket.id });
      console.log(`Sent ICE candidate to ${id}`);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log(`ICE connection state for ${id}: ${peerConnection.iceConnectionState}`);
    if (peerConnection.iceConnectionState === 'failed') {
      peerConnection.restartIce();
    }
  };

  if (initiateOffer) {
    try {
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { sdp: offer, target: id, initiator: socket.id });
      console.log(`Sent offer to ${id}`);
    } catch (err) {
      console.error(`Error creating offer for ${id}:`, err);
    }
  }
}

function addParticipantToList(id, email, camera, mic, isLocal) {
  const participantList = document.getElementById('participant-list');
  const existingItem = document.getElementById(`participant-${id}`);
  if (existingItem) return;

  const participantItem = document.createElement('div');
  participantItem.className = 'participant-item';
  participantItem.id = `participant-${id}`;
  participantItem.onclick = () => addToBigScreen(id);
  participantItem.innerHTML = `
    <span>${isLocal ? `${email} (You)` : email}</span>
    <i class="fas ${camera ? 'fa-video' : 'fa-video-slash'} camera-icon"></i>
    <i class="fas ${mic ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon"></i>
  `;
  participantList.appendChild(participantItem);
}

function updateParticipantStatus(id, camera, mic) {
  const participantItem = document.getElementById(`participant-${id}`);
  if (participantItem) {
    const cameraIcon = participantItem.querySelector('.camera-icon');
    const micIcon = participantItem.querySelector('.mic-icon');
    cameraIcon.className = `fas ${camera ? 'fa-video' : 'fa-video-slash'} camera-icon`;
    micIcon.className = `fas ${mic ? 'fa-microphone' : 'fa-microphone-slash'} mic-icon`;
  }
}

function addToBigScreen(id) {
  if (bigScreenIds.includes(id)) return;
  if (bigScreenIds.length >= 5) {
    bigScreenIds.shift();
  }
  bigScreenIds.push(id);
  clearInterval(cycleInterval);
  updateBigScreen();
  console.log(`Added ${id} to big screen: ${bigScreenIds}`);
}

function updateBigScreen() {
  const bigScreenGrid = document.getElementById('big-screen-grid');
  bigScreenGrid.innerHTML = '';
  bigScreenIds.forEach(id => {
    const participant = participants.find(p => p.id === id);
    if (!participant) return;

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `big-screen-container-${id}`;

    const video = document.createElement('video');
    video.id = `big-screen-video-${id}`;
    video.autoplay = true;
    video.playsInline = true;
    if (id === socket.id) {
      video.srcObject = localStream;
      video.muted = true;
    } else if (peerConnections[id] && peerConnections[id].stream) {
      video.srcObject = peerConnections[id].stream;
    }

    const label = document.createElement('p');
    label.textContent = id === socket.id ? `${participant.email} (You)` : participant.email;

    videoContainer.appendChild(video);
    videoContainer.appendChild(label);
    bigScreenGrid.appendChild(videoContainer);
  });
}

function updateBigScreenCycle() {
  clearInterval(cycleInterval);
  if (bigScreenIds.length === 0 && participants.length > 1) {
    let index = 0;
    cycleInterval = setInterval(() => {
      const maxParticipants = Math.min(participants.length, 5);
      if (index >= maxParticipants) index = 0;
      bigScreenIds = [participants[index].id];
      updateBigScreen();
      index++;
    }, 5000);
  } else if (participants.length === 1) {
    bigScreenIds = [socket.id];
    updateBigScreen();
  }
}

function toggleVideo() {
  const videoTrack = localStream.getVideoTracks()[0];
  videoTrack.enabled = !videoTrack.enabled;
  const btn = document.getElementById('video-btn');
  btn.classList.toggle('off', !videoTrack.enabled);
  btn.querySelector('i').classList.toggle('fa-video', videoTrack.enabled);
  btn.querySelector('i').classList.toggle('fa-video-slash', !videoTrack.enabled);
  btn.setAttribute('title', videoTrack.enabled ? 'Turn off camera' : 'Turn on camera');
  socket.emit('toggle-camera', videoTrack.enabled);
  updateParticipantStatus(socket.id, videoTrack.enabled, localStream.getAudioTracks()[0].enabled);
}

function toggleAudio() {
  const audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = !audioTrack.enabled;
  const btn = document.getElementById('audio-btn');
  btn.classList.toggle('off', !audioTrack.enabled);
  btn.querySelector('i').classList.toggle('fa-microphone', audioTrack.enabled);
  btn.querySelector('i').classList.toggle('fa-microphone-slash', !audioTrack.enabled);
  btn.setAttribute('title', audioTrack.enabled ? 'Mute microphone' : 'Unmute microphone');
  socket.emit('toggle-mic', audioTrack.enabled);
  updateParticipantStatus(socket.id, localStream.getVideoTracks()[0].enabled, audioTrack.enabled);
}

function toggleMoreMenu() {
  const moreMenu = document.getElementById('more-menu');
  moreMenu.style.display = moreMenu.style.display === 'block' ? 'none' : 'block';
  document.getElementById('reaction-picker').style.display = 'none';
}

function toggleReactionPicker() {
  const picker = document.getElementById('reaction-picker');
  picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
}

function sendReaction(emoji) {
  socket.emit('reaction', emoji);
  displayReaction(emoji);
  document.getElementById('reaction-picker').style.display = 'none';
  toggleMoreMenu();
}

function displayReaction(emoji) {
  const reaction = document.createElement('div');
  reaction.className = 'reaction';
  reaction.textContent = emoji;
  document.querySelector('.meeting-container').appendChild(reaction);
  setTimeout(() => reaction.remove(), 3000);
}

function rotateCamera() {
  rotationAngle = (rotationAngle + 90) % 360;
  document.getElementById('video-local').style.transform = `rotate(${rotationAngle}deg)`;
}

async function shareScreen() {
  const btn = document.getElementById('share-screen-btn');
  if (btn.classList.contains('active')) {
    const videoTrack = localStream.getVideoTracks()[0];
    Object.values(peerConnections).forEach(({ peerConnection }) => {
      const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
      sender.replaceTrack(videoTrack);
    });
    document.getElementById('video-local').srcObject = localStream;
    if (bigScreenIds.includes(socket.id)) updateBigScreen();
    btn.classList.remove('active');
    btn.querySelector('i').classList.remove('fa-stop');
    btn.querySelector('i').classList.add('fa-desktop');
  } else {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      Object.values(peerConnections).forEach(({ peerConnection }) => {
        const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
        sender.replaceTrack(screenTrack);
      });
      document.getElementById('video-local').srcObject = screenStream;
      if (bigScreenIds.includes(socket.id)) updateBigScreen();
      btn.classList.add('active');
      btn.querySelector('i').classList.remove('fa-desktop');
      btn.querySelector('i').classList.add('fa-stop');
      screenTrack.onended = () => {
        const videoTrack = localStream.getVideoTracks()[0];
        Object.values(peerConnections).forEach(({ peerConnection }) => {
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
          sender.replaceTrack(videoTrack);
        });
        document.getElementById('video-local').srcObject = localStream;
        if (bigScreenIds.includes(socket.id)) updateBigScreen();
        btn.classList.remove('active');
        btn.querySelector('i').classList.remove('fa-stop');
        btn.querySelector('i').classList.add('fa-desktop');
      };
    } catch (err) {
      console.error('Error sharing screen:', err);
      alert('Failed to share screen.');
    }
  }
  toggleMoreMenu();
}

function hangup() {
  localStream?.getTracks().forEach(track => track.stop());
  Object.values(peerConnections).forEach(({ peerConnection }) => peerConnection.close());
  socket.disconnect();
  clearInterval(cycleInterval);
  window.location.href = '/';
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (message) {
    socket.emit('chat-message', message);
    input.value = '';
  }
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
}