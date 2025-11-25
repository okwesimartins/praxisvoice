// If frontend is hosted on the same domain as the backend, leave this as "".
// If hosted separately, you can set window.BACKEND_URL in HTML.
const BACKEND_URL = window.BACKEND_URL || "";

// DOM elements
const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

// State
let sessionActive = false;
let recognition = null;
let isRecognizing = false;
let currentTranscript = "";
let conversationHistory = []; // { role: "user" | "assistant", text }
let currentEmail = "";
let currentLmsKey = "";

// Logging helper
function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = `log-entry${isError ? " error" : ""}`;
  div.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
  console.log(isError ? "[LOG:ERROR]" : "[LOG]", message);
}

// Speech recognition setup
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

if (!SpeechRecognition) {
  log("Browser does not support Web Speech API (STT). Try Chrome.", true);
}

// Start listening to the user
function startListening() {
  if (!SpeechRecognition) {
    log("SpeechRecognition not available in this browser.", true);
    return;
  }
  if (!sessionActive) return;

  // Make sure we are not speaking
  window.speechSynthesis.cancel();
  speakingIndicator.classList.add("hidden");

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  isRecognizing = true;
  recognition.start();
  log("Listening for your question...");

  let finalTranscript = "";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    if (interim) {
      transcriptEl.textContent = `You (speaking...): ${interim}`;
    }
    if (finalTranscript) {
      const text = finalTranscript.trim();
      if (text) {
        log(`You: ${text}`);
        appendToTranscript("You", text);
        conversationHistory.push({ role: "user", text });
        // Stop listening and send to backend
        isRecognizing = false;
        recognition.stop();
        sendToBackend(text);
      }
    }
  };

  recognition.onerror = (event) => {
    log(`STT error: ${event.error}`, true);
    isRecognizing = false;
  };

  recognition.onend = () => {
    // If STT ended without capturing anything and session is active,
    // just restart listening (idle / silence case).
    if (sessionActive && !isRecognizing && conversationHistory.length === 0) {
      // First time: user didn't say anything; try again.
      setTimeout(() => startListening(), 300);
    }
  };
}

// Append a line to transcript UI
function appendToTranscript(speaker, text) {
  if (!currentTranscript || currentTranscript === "Transcript will appear here...") {
    currentTranscript = "";
    transcriptEl.textContent = "";
  }
  const line = `${speaker}: ${text}`;
  currentTranscript += (currentTranscript ? "\n" : "") + line;
  transcriptEl.textContent = currentTranscript;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Speak AI text using browser TTS
function speakText(text) {
  if (!sessionActive) return;

  // Cancel any previous speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  // Slightly faster, slightly higher pitch to feel more "alive"
  utterance.rate = 1.15;
  utterance.pitch = 1.05;
  utterance.volume = 1.0;

  utterance.onstart = () => {
    speakingIndicator.classList.remove("hidden");
    log("Praxis is speaking...");
  };

  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
    log("Praxis finished speaking.");
    if (sessionActive) {
      // After AI finishes, listen again
      setTimeout(() => startListening(), 300);
    }
  };

  utterance.onerror = (e) => {
    speakingIndicator.classList.add("hidden");
    log(`TTS error: ${e.error}`, true);
    if (sessionActive) {
      setTimeout(() => startListening(), 500);
    }
  };

  window.speechSynthesis.speak(utterance);
}

// Call backend /api/chat with user text + history
async function sendToBackend(userText) {
  try {
    log("Sending message to backend...");
    const body = {
      student_email: currentEmail,
      lmsKey: currentLmsKey || undefined,
      message: userText,
      history: conversationHistory, // includes previous user + assistant turns
    };

    const url = `${BACKEND_URL}/api/chat`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      log(`Backend error: ${res.status} ${errText}`, true);
      // Try listening again so user can retry
      if (sessionActive) setTimeout(() => startListening(), 800);
      return;
    }

    const data = await res.json();
    const aiText = (data && data.text) || "(no response text)";
    appendToTranscript("Praxis", aiText);
    log(`Praxis: ${aiText}`);
    conversationHistory.push({ role: "assistant", text: aiText });

    // Speak the AI reply
    speakText(aiText);
  } catch (err) {
    log(`Request failed: ${err.message}`, true);
    if (sessionActive) setTimeout(() => startListening(), 800);
  }
}

// Start/stop handlers
function handleStart() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email", true);
    return;
  }

  currentEmail = email;
  currentLmsKey = lmsKeyInput.value.trim();
  sessionActive = true;
  conversationHistory = [];
  currentTranscript = "";
  transcriptEl.textContent = "Transcript will appear here...";
  logsEl.textContent = "";
  log("Session started.");

  startBtn.disabled = true;
  stopBtn.disabled = false;
  emailInput.disabled = true;
  lmsKeyInput.disabled = true;

  // Start listening immediately
  startListening();
}

function handleStop() {
  sessionActive = false;
  log("Stopping session...");

  // Stop STT
  try {
    if (recognition) recognition.stop();
  } catch (_) {}

  // Stop TTS
  window.speechSynthesis.cancel();
  speakingIndicator.classList.add("hidden");

  startBtn.disabled = false;
  stopBtn.disabled = true;
  emailInput.disabled = false;
  lmsKeyInput.disabled = false;
}

// Event listeners
startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  sessionActive = false;
  try {
    if (recognition) recognition.stop();
  } catch (_) {}
  window.speechSynthesis.cancel();
});
