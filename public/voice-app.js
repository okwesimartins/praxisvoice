const BACKEND_URL = "https://veritas-ai-voice-156084498565.europe-west1.run.app";

// DOM elements
const emailInput = document.getElementById('email');
const lmsKeyInput = document.getElementById('lmsKey');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const transcriptEl = document.getElementById('transcript');
const logsEl = document.getElementById('logs');
const speakingIndicator = document.getElementById('speakingIndicator');

// State
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let playTime = 0;
let isConnected = false;
let currentTranscript = '';

// Logging
function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry${isError ? ' error' : ''}`;
  logEntry.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(logEntry);
  logsEl.scrollTop = logsEl.scrollHeight;
}

// Audio encoding utilities
function base64FromArrayBuffer(ab) {
  let binary = '';
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function arrayBufferFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleBuffer(buffer, sampleRate, outRate = 16000) {
  if (outRate === sampleRate) return buffer;
  const ratio = sampleRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offset = 0;
  
  for (let i = 0; i < newLen; i++) {
    const nextOffset = Math.round((i + 1) * ratio);
    let sum = 0, count = 0;
    for (let j = offset; j < nextOffset && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    result[i] = sum / count;
    offset = nextOffset;
  }
  return result;
}

// Microphone management
async function startMic() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    
    const source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleBuffer(input, audioCtx.sampleRate, 16000);
      const pcm16 = floatTo16BitPCM(down);
      const buffer = pcm16.buffer;
      ws.send(JSON.stringify({ 
        type: "audio", 
        data: base64FromArrayBuffer(buffer) 
      }));
    };

    log('Microphone started');
  } catch (error) {
    log(`Mic error: ${error.message}`, true);
  }
}

function stopMic() {
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close();
    audioCtx = null;
  }
  log('Microphone stopped');
}

// Audio playback with 1.2x speed
function playPcm16(base64Pcm) {
  if (!audioCtx) return;

  try {
    const ab = arrayBufferFromBase64(base64Pcm);
    const pcm16 = new Int16Array(ab);
    const float32 = new Float32Array(pcm16.length);
    
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 0x8000;
    }

    // 1.2x faster playback
    const targetRate = 16000 * 1.2;
    const buf = audioCtx.createBuffer(1, float32.length, targetRate);
    buf.copyToChannel(float32, 0);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (playTime < now) playTime = now;
    src.start(playTime);
    playTime += buf.duration;

    speakingIndicator.classList.remove('hidden');
    setTimeout(() => speakingIndicator.classList.add('hidden'), buf.duration * 1000);
  } catch (error) {
    log(`Audio error: ${error.message}`, true);
  }
}

// WebSocket management
function handleStart() {
  const email = emailInput.value.trim();
  if (!email) {
    log('Please enter student email', true);
    return;
  }

  currentTranscript = '';
  transcriptEl.textContent = 'Transcript will appear here...';
  log('Connecting to backend...');

  ws = new WebSocket(`${BACKEND_URL.replace('https://', 'wss://')}/ws`);

  ws.onopen = () => {
    log('WebSocket connected');
    ws.send(JSON.stringify({
      type: "start",
      student_email: email,
      lmsKey: lmsKeyInput.value.trim() || undefined
    }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "ready") {
      log('Gemini ready - starting mic...');
      isConnected = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      emailInput.disabled = true;
      lmsKeyInput.disabled = true;
      await startMic();
    }

    if (msg.type === "text") {
      currentTranscript += msg.text;
      transcriptEl.textContent = currentTranscript;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      log(`AI: ${msg.text}`);
    }

    if (msg.type === "audio") {
      playPcm16(msg.data);
    }

    if (msg.type === "error") {
      log(`ERROR: ${msg.error}`, true);
    }

    if (msg.type === "turnComplete") {
      speakingIndicator.classList.add('hidden');
    }
  };

  ws.onerror = () => {
    log('WebSocket error', true);
  };

  ws.onclose = () => {
    log('Session ended');
    stopMic();
    speakingIndicator.classList.add('hidden');
    isConnected = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
  };
}

function handleStop() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  log('Stopping session...');
}

// Event listeners
startBtn.addEventListener('click', handleStart);
stopBtn.addEventListener('click', handleStop);

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
  stopMic();
});
