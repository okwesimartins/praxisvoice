// =======================
// CONFIG
// =======================
const API_BASE = ""; // "" = same origin as server.js. Or e.g. "https://your-backend-url"
const CHAT_PATH = "/api/praxis/text"; // backend route that talks to Gemini

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
let recognition = null;
let recognizing = false;
let sessionActive = false;

let selectedVoice = null;
let isSending = false; // avoid overlapping requests
let conversation = []; // simple array of {role, text}

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
// BROWSER TTS (SPEECHSYNTHESIS)
// =======================
function pickBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) {
    console.log("No TTS voices available (yet).");
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

// Load voices (async in some browsers)
window.speechSynthesis.onvoiceschanged = pickBestVoice;
pickBestVoice();

// Speak AI text
function speakText(text) {
  if (!sessionActive || !text) return;

  // Cancel any ongoing speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  // Tweak to sound less robotic
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
    // Go back to listening (barge-in style)
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
// BROWSER STT (SPEECHRECOGNITION)
// =======================
function setupRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    log("SpeechRecognition not supported in this browser.", true);
    alert(
      "Your browser does not support voice recognition. Please use Chrome or Edge."
    );
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false; // single utterance per turn
  recognition.interimResults = true; // show partials

  recognition.onstart = () => {
    recognizing = true;
    log("Listening...");
  };

  recognition.onend = () => {
    recognizing = false;
    log("Stopped listening.");
    // We don't restart here automatically; we restart after AI finishes talking
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

    // Show interim text live (as user speaks)
    if (interimText) {
      const tempConv = [...conversation, { role: "user", text: interimText }];
      transcriptEl.innerHTML = "";
      tempConv.forEach((turn) => {
        const p = document.createElement("p");
        p.className = `turn turn-${turn.role}`;
        const label = turn.role === "user" ? "You" : "Praxis";
        p.innerHTML = `<strong>${label}:</strong> ${turn.text}`;
        transcriptEl.appendChild(p);
      });
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    // Once we get final text, send to backend
    if (finalText.trim()) {
      handleUserText(finalText.trim());
    }
  };
}

function startListening() {
  if (!sessionActive) return;
  if (!recognition) {
    setupRecognition();
  }
  if (!recognition) return; // still unsupported

  // If currently speaking, stop TTS and start listening
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }

  try {
    recognition.start();
  } catch (e) {
    // Ignore "already started" errors
    console.log("Recognition start error:", e.message);
  }
}

function stopListening() {
  if (recognition && recognizing) {
    recognition.stop();
  }
}

// =======================
// BACKEND CALL
// =======================
async function sendToBackend(text) {
  const email = emailInput.value.trim();
  const lmsKey = lmsKeyInput.value.trim() || undefined;

  if (!email) {
    log("Missing student email.", true);
    return;
  }

  if (isSending) {
    log("Still waiting for previous reply, skipping...", true);
    return;
  }

  isSending = true;
  log(`Sending to backend: "${text}"`);

  try {
    const res = await fetch(API_BASE + CHAT_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        student_email: email,
        lmsKey,
      }),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    const data = await res.json();

    const replyText = data.reply || "(No reply text)";
    log(`Praxis reply: ${replyText}`);

    // Add AI reply to conversation
    conversation.push({ role: "assistant", text: replyText });

    // If backend also returns links (e.g. YouTube / articles), render them nicely
    if (Array.isArray(data.links) && data.links.length) {
      const linksText = data.links
        .map((l, idx) => `${idx + 1}. ${l.title || l.link || ""}`)
        .join("\n");
      conversation.push({
        role: "assistant",
        text: `Here are some resources:\n${linksText}`,
      });
    }

    renderTranscript();
    speakText(replyText);
  } catch (err) {
    log(`Backend error: ${err.message}`, true);
    if (sessionActive) {
      // Try listening again
      setTimeout(() => startListening(), 1000);
    }
  } finally {
    isSending = false;
  }
}

// When STT confirms user text
function handleUserText(text) {
  // Commit user text to conversation
  conversation.push({ role: "user", text });
  renderTranscript();

  // Pause listening while we get + speak AI reply
  stopListening();

  // Ask backend
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

  sessionActive = true;
  conversation = [];
  renderTranscript();

  startBtn.disabled = true;
  stopBtn.disabled = false;
  emailInput.disabled = true;
  lmsKeyInput.disabled = true;

  log("Session started. Say something!");
  startListening();
}

function handleStop() {
  sessionActive = false;
  stopListening();
  window.speechSynthesis.cancel();

  startBtn.disabled = false;
  stopBtn.disabled = true;
  emailInput.disabled = false;
  lmsKeyInput.disabled = false;

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
  stopListening();
  window.speechSynthesis.cancel();
});
