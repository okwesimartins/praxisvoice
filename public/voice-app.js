// public/voice-app.js

// If you want to hard-code Cloud Run URL, set this.
// If frontend is served by the same backend, leave as null to auto-detect.
const BACKEND_URL = null; // e.g. "https://veritas-ai-voice-XXXX.run.app";

const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

let ws = null;
let recognition = null;
let isConnected = false;
let currentTranscript = "";

// -----------------------------------------------------------------------------
// Logging helper
// -----------------------------------------------------------------------------
function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry${isError ? " error" : ""}`;
  entry.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(entry);
  logsEl.scrollTop = logsEl.scrollHeight;
  console.log(isError ? "[LOG:ERROR]" : "[LOG]", message);
}

// -----------------------------------------------------------------------------
// Speech Recognition (browser STT)
// -----------------------------------------------------------------------------
function initSpeechRecognition() {
  const SR =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (!SR) {
    log(
      "SpeechRecognition API is not supported in this browser. Use Chrome or Edge.",
      true
    );
    return null;
  }

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";

  rec.onstart = () => {
    log("Microphone listening...");
  };

  rec.onerror = (event) => {
    log(`SpeechRecognition error: ${event.error}`, true);
  };

  rec.onend = () => {
    log("SpeechRecognition stopped.");
    if (isConnected) {
      // Automatically restart to keep listening during session
      try {
        rec.start();
      } catch (_) {}
    }
  };

  rec.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const text = last[0].transcript.trim();
    if (!text) return;

    // Show interim text in logs (optional)
    if (!last.isFinal) {
      log(`(hearing) ${text}`);
      return;
    }

    // Final recognized user utterance
    log(`You: ${text}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "userText",
          text,
        })
      );
    }
  };

  return rec;
}

function startListening() {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }
  if (!recognition) return;

  try {
    recognition.start();
  } catch (e) {
    // Starting twice throws in some browsers; ignore
  }
}

function stopListening() {
  if (recognition) {
    try {
      recognition.onend = null; // prevent auto-restart
      recognition.stop();
    } catch (_) {}
  }
}

// -----------------------------------------------------------------------------
// Text-to-speech (browser TTS)
// -----------------------------------------------------------------------------
function speak(text) {
  if (!("speechSynthesis" in window)) {
    log("speechSynthesis not supported in this browser.", true);
    return;
  }

  // Cancel any previous speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  // Slightly faster + brighter
  utterance.rate = 1.15;
  utterance.pitch = 1.05;

  utterance.onstart = () => {
    speakingIndicator.classList.remove("hidden");
  };
  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
  };
  utterance.onerror = (e) => {
    log(`TTS error: ${e.error}`, true);
    speakingIndicator.classList.add("hidden");
  };

  window.speechSynthesis.speak(utterance);
}

// -----------------------------------------------------------------------------
// WebSocket management
// -----------------------------------------------------------------------------
function getWsUrl() {
  if (BACKEND_URL) {
    return BACKEND_URL.replace(/^http/i, "ws") + "/ws";
  }
  return (
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/ws"
  );
}

function handleStart() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email", true);
    return;
  }

  currentTranscript = "";
  transcriptEl.textContent = "Transcript will appear here...";
  log("Connecting to backend...");

  const wsUrl = getWsUrl();
  log(`WS URL: ${wsUrl}`);
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

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn("Non-JSON WS message:", event.data);
      return;
    }

    console.log("📥 WS message:", msg);

    if (msg.type === "ready") {
      log("Praxis is ready. Starting microphone...");
      isConnected = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      emailInput.disabled = true;
      lmsKeyInput.disabled = true;
      startListening();
    }

    if (msg.type === "aiThinking") {
      log("Praxis is thinking...");
    }

    if (msg.type === "aiText") {
      // Clear placeholder on first chunk
      if (
        !currentTranscript ||
        currentTranscript === "Transcript will appear here..."
      ) {
        currentTranscript = "";
        transcriptEl.textContent = "";
      }

      // Append AI text to transcript
      currentTranscript +=
        (currentTranscript ? "\n\n" : "") + String(msg.text || "");
      transcriptEl.textContent = currentTranscript;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;

      log(`AI: ${msg.text}`);
      speak(msg.text);
    }

    if (msg.type === "error") {
      log(`ERROR: ${msg.error}`, true);
    }

    if (msg.type === "info") {
      log(msg.message || "Info from server");
    }
  };

  ws.onerror = (event) => {
    console.error("WS error:", event);
    log("WebSocket error", true);
  };

  ws.onclose = () => {
    log("Session ended");
    isConnected = false;
    stopListening();
    speakingIndicator.classList.add("hidden");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
  };
}

function handleStop() {
  log("Stopping session...");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  } else {
    stopListening();
  }
}

// -----------------------------------------------------------------------------
// UI events
// -----------------------------------------------------------------------------
startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);

window.addEventListener("beforeunload", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  stopListening();
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
});
