// public/voice-app.js

// Point this to your backend base URL (no /ws here)
const BACKEND_URL = "https://veritas-ai-voice-156084498565.europe-west1.run.app";

// DOM elements
const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

// State
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let playTime = 0; // no longer used for server audio, kept just in case
let isConnected = false;
let currentTranscript = "";
let pendingUtteranceText = "";

// SpeechSynthesis
let selectedVoice = null;

function initVoices() {
  if (!window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return;

  // Try to pick a lighter, more "friendly" voice if possible
  selectedVoice =
    voices.find((v) =>
      /female|Google UK English Female|Google US English/gim.test(v.name)
    ) || voices[0];

  console.log("🔊 Selected TTS voice:", selectedVoice?.name);
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = initVoices;
  initVoices();
}

// Logging
function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement("div");
  logEntry.className = `log-entry${isError ? " error" : ""}`;
  logEntry.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(logEntry);
  logsEl.scrollTop = logsEl.scrollHeight;
}

// Audio encoding utilities (for mic → backend)
function base64FromArrayBuffer(ab) {
  let binary = "";
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

// Microphone management (still sending audio to backend for STT)
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
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.close();
    audioCtx = null;
  }
  log("Microphone stopped");
}

// TTS: speak the AI answer (after turnComplete)
function speakText(text) {
  if (!("speechSynthesis" in window)) {
    log("SpeechSynthesis not supported in this browser", true);
    return;
  }
  if (!text || !text.trim()) return;

  // Cancel any previous speech to avoid queue piling up
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.2; // faster
  utterance.pitch = 1.1; // slightly higher, lighter
  utterance.volume = 1.0;

  if (selectedVoice) utterance.voice = selectedVoice;

  utterance.onstart = () => {
    speakingIndicator.classList.remove("hidden");
  };
  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
  };
  utterance.onerror = (e) => {
    speakingIndicator.classList.add("hidden");
    log(`TTS error: ${e.error || "unknown"}`, true);
  };

  window.speechSynthesis.speak(utterance);
}

// WebSocket management
function handleStart() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email", true);
    return;
  }

  currentTranscript = "";
  pendingUtteranceText = "";
  transcriptEl.textContent = "Transcript will appear here...";
  logsEl.innerHTML = "";
  log("Connecting to backend...");

  const wsUrl = `${BACKEND_URL.replace("https://", "wss://")}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log("WebSocket connected");
    ws.send(
      JSON.stringify({
        type: "start",
        student_email: email,
        lmsKey: lmsKeyInput.value.trim() || undefined,
      })
    );
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    console.log("🛰 WS message from backend:", msg);

    if (msg.type === "ready") {
      log("Gemini ready - starting mic...");
      isConnected = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      emailInput.disabled = true;
      lmsKeyInput.disabled = true;
      await startMic();
    }

    if (msg.type === "text") {
      // Update transcript and pending speech text
      currentTranscript += msg.text;
      pendingUtteranceText += msg.text;

      transcriptEl.textContent = currentTranscript;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;

      log(`AI: ${msg.text}`);
    }

    // No audio from server now – TTS happens in browser
    // if (msg.type === "audio") { ... }

    if (msg.type === "turnComplete") {
      // Turn finished → speak the accumulated text
      if (pendingUtteranceText.trim()) {
        speakText(pendingUtteranceText);
        pendingUtteranceText = "";
      }
    }

    if (msg.type === "error") {
      log(`ERROR: ${msg.error}`, true);
    }
  };

  ws.onerror = (err) => {
    console.error("WS error:", err);
    log("WebSocket error", true);
  };

  ws.onclose = () => {
    log("Session ended");
    stopMic();
    speakingIndicator.classList.add("hidden");
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
  log("Stopping session...");
}

// Event listeners
startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  if (ws) ws.close();
  stopMic();
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
});
