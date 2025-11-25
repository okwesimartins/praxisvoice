// =======================
// CONFIG
// =======================

// If frontend is served by the same backend, leave API_BASE empty ("").
// If hosted elsewhere, set it to your Cloud Run URL:
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
let lastRequestId = null;

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
// TEXT CLEANUP FOR SPEECH
// =======================
function sanitizeForSpeech(text) {
  let t = text;

  // Remove markdown bold/italics markers
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");
  t = t.replace(/__(.+?)__/g, "$1");
  t = t.replace(/\*(.+?)\*/g, "$1");
  t = t.replace(/_(.+?)_/g, "$1");

  // Remove leading bullets / block markers (*, -, >)
  t = t.replace(/^[\s>*-]+\s*/gm, "");

  // Remove backticks and backslashes
  t = t.replace(/`+/g, "");
  t = t.replace(/\\/g, "");

  // Collapse multiple spaces / newlines
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
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

  // Prefer a calm adult-ish English voice if possible
  selectedVoice =
    voices.find(
      (v) =>
        /en/i.test(v.lang) &&
        /Male|Narrator|Daniel|George|Guy/i.test(v.name)
    ) ||
    voices.find((v) => /Google US English/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang && v.lang.startsWith("en")) ||
    voices[0];

  console.log("Selected voice:", selectedVoice && selectedVoice.name);
}

window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

function speakText(fullText) {
  if (!sessionActive || !fullText) return;

  // Clean up markdown & weird characters before speaking
  const cleaned = sanitizeForSpeech(fullText);

  // Don't read full URLs out loud
  const speakable = cleaned.replace(/https?:\/\/\S+/g, "a link I found");

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speakable);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  // Slower & lower pitch for "teacher" vibe
  utterance.rate = 0.9;   // was 1.1
  utterance.pitch = 0.9;  // slightly deeper
  utterance.volume = 1.0;

  utterance.onstart = () => {
    speakingIndicator.classList.remove("hidden");
    log("Praxis is speaking...");
  };

  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
    log("Praxis finished speaking.");
    // We do NOT startListening here; recognition runs continuously.
  };

  utterance.onerror = (e) => {
    speakingIndicator.classList.add("hidden");
    log(`TTS error: ${e.error}`, true);
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
  recognition.continuous = true; // keep listening
  recognition.interimResults = true;

  recognition.onstart = () => {
    recognizing = true;
    log("Listening...");
  };

  recognition.onend = () => {
    recognizing = false;
    log("Stopped listening.");
    if (sessionActive) {
      // Auto-restart after a small pause
      setTimeout(() => {
        try {
          recognition.start();
        } catch (e) {
          console.log("Recognition restart error:", e.message);
        }
      }, 400);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      // Harmless: just means silence. Restart.
      recognizing = false;
      log("No speech detected, still listening...");
      if (sessionActive) {
        setTimeout(() => {
          try {
            recognition.start();
          } catch (e) {}
        }, 400);
      }
      return;
    }

    log(`STT error: ${event.error}`, true);
    recognizing = false;
    if (sessionActive) {
      setTimeout(() => {
        try {
          recognition.start();
        } catch (e) {}
      }, 800);
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
      // 🔹 BARGE-IN: stop AI speech if it's talking
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        speakingIndicator.classList.add("hidden");
      }
      handleUserText(finalText.trim());
    }
  };
}

function startListening() {
  if (!sessionActive) return;
  if (!recognition) setupRecognition();
  if (!recognition) return;

  try {
    if (!recognizing) {
      recognition.start();
    }
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

  const requestId = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  lastRequestId = requestId;

  log(`Sending to backend: "${text}"`);

  ws.send(
    JSON.stringify({
      type: "user_text",
      text,
      requestId,
    })
  );
}

// When STT final text is ready
function handleUserText(text) {
  conversation.push({ role: "user", text });
  renderTranscript();

  // Keep listening; don't stop recognition here.
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

  sessionActive = false;
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
      startListening();
      return;
    }

    if (msg.type === "assistant_text") {
      // Ignore stale replies from previous questions (after barge-in)
      if (msg.requestId && lastRequestId && msg.requestId !== lastRequestId) {
        console.log("Ignoring stale response:", msg.requestId);
        return;
      }

      const reply = msg.text || "";
      conversation.push({ role: "assistant", text: reply });
      renderTranscript();
      speakText(reply);
      return;
    }

    if (msg.type === "error") {
      log(`ERROR: ${msg.error}`, true);
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
  speakingIndicator.classList.add("hidden");

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

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
