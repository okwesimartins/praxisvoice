// ================= CONFIG =================

// WebSocket URL (same origin as server.js)
const WS_URL =
  (location.protocol === "https:" ? "wss://" : "ws://") +
  location.host +
  "/ws";

// ================= DOM ELEMENTS =================

const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

// ================= STATE =================

let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let playTime = 0;

// ================= LOGGING =================

function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = "log-entry" + (isError ? " error" : "");
  div.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
  console[isError ? "error" : "log"](message);
}

// ================= TRANSCRIPT UI =================

function clearTranscriptIfPlaceholder() {
  if (transcriptEl.textContent.trim() === "Transcript will appear here...") {
    transcriptEl.innerHTML = "";
  }
}

function addTranscriptLine(role, text) {
  clearTranscriptIfPlaceholder();
  const line = document.createElement("div");
  line.className = "transcript-line " + role; // "assistant"
  line.textContent = (role === "assistant" ? "Praxis: " : "") + text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ================= AUDIO UTILS =================

function base64FromArrayBuffer(ab) {
  let binary = "";
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
    let sum = 0,
      count = 0;
    for (let j = offset; j < nextOffset && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    result[i] = sum / count;
    offset = nextOffset;
  }
  return result;
}

// ================= MIC CAPTURE =================

async function startMic() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
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

      ws.send(
        JSON.stringify({
          type: "audio",
          data: base64FromArrayBuffer(buffer),
        })
      );
    };

    log("Microphone started");
  } catch (err) {
    log("Mic error: " + err.message, true);
  }
}

function stopMic() {
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close();
    audioCtx = null;
  }
  log("Microphone stopped");
}

// ================= PLAYBACK OF GEMINI AUDIO =================

function playPcm16(base64Pcm) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  try {
    const ab = arrayBufferFromBase64(base64Pcm);
    const pcm16 = new Int16Array(ab);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 0x8000;
    }

    const buf = audioCtx.createBuffer(1, float32.length, 16000);
    buf.copyToChannel(float32, 0);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (playTime < now) playTime = now;
    src.start(playTime);
    playTime += buf.duration;

    speakingIndicator.classList.remove("hidden");
    src.onended = () => {
      speakingIndicator.classList.add("hidden");
    };
  } catch (err) {
    log("Playback error: " + err.message, true);
  }
}

// ================= WS SESSION CONTROL =================

function startSession() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email.", true);
    return;
  }

  transcriptEl.textContent = "Transcript will appear here...";
  logsEl.textContent = "";
  playTime = 0;

  emailInput.disabled = true;
  lmsKeyInput.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  const lmsKey = lmsKeyInput.value.trim() || undefined;

  log("Connecting WebSocket...");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    log("WebSocket connected. Sending start...");
    ws.send(
      JSON.stringify({
        type: "start",
        student_email: email,
        lmsKey,
      })
    );
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("WS parse error:", e);
      return;
    }

    if (msg.type === "ready") {
      log("Gemini session ready. Starting mic...");
      startMic();
      return;
    }

    if (msg.type === "audio") {
      playPcm16(msg.data);
      return;
    }

    if (msg.type === "text") {
      addTranscriptLine("assistant", msg.text);
      return;
    }

    if (msg.type === "turnComplete") {
      // Turn ended; indicator is already handled by audio onended
      return;
    }

    if (msg.type === "error") {
      log("Backend error: " + msg.error, true);
      return;
    }
  };

  ws.onerror = (e) => {
    console.error("WS error:", e);
    log("WebSocket error.", true);
  };

  ws.onclose = () => {
    log("WebSocket closed.");
    stopMic();
    speakingIndicator.classList.add("hidden");

    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };
}

function stopSession() {
  stopMic();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

  speakingIndicator.classList.add("hidden");
  emailInput.disabled = false;
  lmsKeyInput.disabled = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;

  log("Session stopped.");
}

// ================= EVENT LISTENERS =================

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

window.addEventListener("beforeunload", () => {
  stopSession();
});
