// =======================
// CONFIG
// =======================

// If frontend is served by the same backend, leave API_BASE empty ("").
// If you host the HTML elsewhere, set it to your Cloud Run URL like:
// const API_BASE = "https://veritas-ai-voice-156084498565.europe-west1.run.app";
const API_BASE = "";

// Build WS URL from API_BASE or current origin
const WS_BASE = API_BASE || window.location.origin;
const WS_URL = WS_BASE.replace(/^http/, "ws") + "/ws";

// =======================
// DOM ELEMENTS
// =======================
const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

// =======================
// STATE
// =======================
let ws = null;

let recognition = null;
let recognizing = false;
let sessionActive = false;

let selectedVoice = null;
let isSending = false;
let conversation = []; // [{role:"user"|"assistant", text}]

// =======================
// LOGGING
// =======================
function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry${isError ? " error" : ""}`;
  entry.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(entry);
  logsEl.scrollTop = logsEl.scrollHeight;
  console[isError ? "error" : "log"]("[LOG]", message);
}

// =======================
// TRANSCRIPT UI
// =======================
function renderTranscript() {
  if (!conversation.length) {
    transcriptEl.textContent = "Transcript will appear here...";
    return;
  }

  transcriptEl.innerHTML = "";
  conversation.forEach((turn) => {
    const p = document.createElement("p");
    p.className = `turn turn-${turn.role}`;
    const label = turn.role === "user" ? "You" : "Praxis";
    p.innerHTML = `<strong>${label}:</strong> ${turn.text}`;
    transcriptEl.appendChild(p);
  });

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// =======================
// BROWSER TTS (speechSynthesis)
// =======================
function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) {
    console.log("No TTS voices available yet.");
    return;
  }

  console.log("Available voices:", voices);

  selectedVoice =
    voices.find((v) => /Google UK English Female/i.test(v.name)) ||
    voices.find((v) => /Google US English/i.test(v.name)) ||
    voices.find((v) => /Google English/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang && v.lang.startsWith("en")) ||
    voices[0];

  console.log("Selected voice:", selectedVoice && selectedVoice.name);
}

window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function speakText(fullText) {
  if (!sessionActive || !fullText) return;

  // Don't make the browser read full URLs
  const speakable = fullText.replace(/https?:\/\/\S+/g, "a link I found");

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  utterance.rate = 1.1;   // slightly faster
  utterance.pitch = 1.05; // slightly brighter
  utterance.volume = 1.0;

  utterance.onstart = () => {
    speakingIndicator.classList.remove("hidden");
    log("Praxis is speaking...");
  };

  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
    log("Praxis finished speaking.");
    if (sessionActive) {
      startListening();
    }
  };

  utterance.onerror = (e) => {
    speakingIndicator.classList.add("hidden");
    log(`TTS error: ${e.error}`, true);
    if (sessionActive) {
      startListening();
    }
  };

  window.speechSynthesis.speak(utterance);
}

// =======================
// BROWSER STT (SpeechRecognition)
// =======================
function setupRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    log("SpeechRecognition not supported in this browser.", true);
    alert("Your browser does not support voice recognition. Use Chrome or Edge.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false; // one turn at a time
  recognition.interimResults = true;

  recognition.onstart = () => {
    recognizing = true;
    log("Listening...");
  };

  recognition.onend = () => {
    recognizing = false;
    log("Stopped listening.");
  };

  recognition.onerror = (event) => {
    log(`STT error: ${event.error}`, true);
    recognizing = false;
    if (sessionActive && event.error !== "no-speech") {
      setTimeout(() => startListening(), 800);
    }
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) {
        finalText += transcript + " ";
      } else {
        interimText += transcript + " ";
      }
    }

    // Show interim text as user is talking
    if (interimText) {
      const temp = [...conversation, { role: "user", text: interimText }];
      transcriptEl.innerHTML = "";
      temp.forEach((turn) => {
        const p = document.createElement("p");
        p.className = `turn turn-${turn.role}`;
        const label = turn.role === "user" ? "You" : "Praxis";
        p.innerHTML = `<strong>${label}:</strong> ${turn.text}`;
        transcriptEl.appendChild(p);
      });
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    if (finalText.trim()) {
      handleUserText(finalText.trim());
    }
  };
}

function startListening() {
  if (!sessionActive) return;
  if (!recognition) setupRecognition();
  if (!recognition) return;

  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }

  try {
    recognition.start();
  } catch (e) {
    console.log("Recognition start error:", e.message);
  }
}

function stopListening() {
  if (recognition && recognizing) {
    recognition.stop();
  }
}

// =======================
// WS CALL
// =======================
function sendToBackend(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("WebSocket not open.", true);
    return;
  }
  if (isSending) {
    log("Still waiting for previous reply, skipping...", true);
    return;
  }

  isSending = true;
  log(`Sending to backend: "${text}"`);
  ws.send(
    JSON.stringify({
      type: "user_text",
      text,
    })
  );
}

// When STT final text is ready
function handleUserText(text) {
  conversation.push({ role: "user", text });
  renderTranscript();

  stopListening();
  sendToBackend(text);
}

// =======================
// SESSION CONTROL
// =======================
function handleStart() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email", true);
    return;
  }

  sessionActive = false; // will flip true on "ready"
  conversation = [];
  renderTranscript();

  startBtn.disabled = true;
  stopBtn.disabled = false;
  emailInput.disabled = true;
  lmsKeyInput.disabled = true;

  log(`Connecting to WS: ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    log("WebSocket connected, sending start...");
    ws.send(
      JSON.stringify({
        type: "start",
        student_email: email,
        lmsKey: lmsKeyInput.value.trim() || undefined,
      })
    );
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("Bad WS message:", event.data);
      return;
    }

    if (msg.type === "ready") {
      log("Backend ready. You can start speaking.");
      sessionActive = true;
      isSending = false;
      startListening();
      return;
    }

    if (msg.type === "assistant_text") {
      const reply = msg.text || "";
      isSending = false;

      conversation.push({ role: "assistant", text: reply });
      renderTranscript();
      speakText(reply);
      return;
    }

    if (msg.type === "error") {
      log(`ERROR: ${msg.error}`, true);
      isSending = false;
      if (sessionActive) {
        setTimeout(() => startListening(), 1000);
      }
      return;
    }
  };

  ws.onerror = (event) => {
    console.error("WS error:", event);
    log("WebSocket error", true);
  };

  ws.onclose = () => {
    log("WebSocket closed / session ended");
    sessionActive = false;
    isSending = false;
    stopListening();
    window.speechSynthesis.cancel();
    speakingIndicator.classList.add("hidden");

    startBtn.disabled = false;
    stopBtn.disabled = true;
    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
  };
}

function handleStop() {
  sessionActive = false;
  stopListening();
  window.speechSynthesis.cancel();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

  speakingIndicator.classList.add("hidden");
  log("Session stopped.");
}

// =======================
// EVENT LISTENERS
// =======================
startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);

window.addEventListener("beforeunload", () => {
  sessionActive = false;
  if (ws) ws.close();
  stopListening();
  window.speechSynthesis.cancel();
});
