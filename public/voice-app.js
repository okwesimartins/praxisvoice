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
const talkBtn = document.getElementById("talkBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

// ================= STATE =================

let ws = null;
let wsReady = false;
let sessionActive = false;

let recognition = null;
let recognizing = false;

let voicesLoaded = false;
let isSpeaking = false;
let conversationHistory = [];
let lastRequestId = null;

// ================= UTIL: LOGGING =================

function log(message, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = "log-entry" + (isError ? " error" : "");
  div.textContent = `[${timestamp}] ${message}`;
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
  console[isError ? "error" : "log"](message);
}

// ================= UI HELPERS =================

function setUiState() {
  emailInput.disabled = sessionActive;
  lmsKeyInput.disabled = sessionActive;

  startBtn.disabled = sessionActive;
  stopBtn.disabled = !sessionActive;

  // Talk is only enabled when session is active and WS ready
  talkBtn.disabled = !sessionActive || !wsReady || recognizing;
}

function clearTranscriptIfPlaceholder() {
  if (transcriptEl.textContent.trim() === "Transcript will appear here...") {
    transcriptEl.innerHTML = "";
  }
}

function addTranscriptLine(role, text) {
  clearTranscriptIfPlaceholder();
  const line = document.createElement("div");
  line.className = "transcript-line " + role; // "user" or "assistant"
  line.textContent = (role === "user" ? "You: " : "Praxis: ") + text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ================= TTS: SPEECH SYNTHESIS =================

function sanitizeForSpeech(fullText) {
  if (!fullText) return "";

  let text = fullText;

  // Strip markdown bullets / formatting
  text = text.replace(/[*_`>#\-]+/g, " ");

  // Try to drop explicit "Links:" / "Resources:" sections from speech
  const linksIndex = text.search(/(links:|resources:)/i);
  if (linksIndex !== -1) {
    text = text.slice(0, linksIndex);
  }

  // Remove raw URLs so browser doesn't read "https colon slash slash..."
  text = text.replace(/https?:\/\/\S+/gi, " ");

  // Fix some pronunciations
  text = text.replace(/\bExcel\b/gi, "Microsoft Excel");

  // Collapse multiple spaces
  text = text.replace(/\s{2,}/g, " ");

  return text.trim();
}

function pickNiceVoice() {
  const allVoices = window.speechSynthesis.getVoices();
  if (!allVoices || !allVoices.length) return null;

  // Prefer Google voices (usually more natural)
  const googleVoice =
    allVoices.find((v) =>
      /Google US English|Google UK English/i.test(v.name)
    ) || allVoices.find((v) => /Google/i.test(v.name));

  return googleVoice || allVoices[0];
}

function speakText(fullText) {
  if (!("speechSynthesis" in window)) {
    log("Browser does not support speech synthesis (TTS).", true);
    return;
  }

  const spoken = sanitizeForSpeech(fullText);
  if (!spoken) return;

  // Cancel any current speech
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(spoken);

  // Slightly slower than default, normal pitch
  utterance.rate = 0.9;
  utterance.pitch = 1.0;

  // Load voices if needed
  if (voicesLoaded) {
    const voice = pickNiceVoice();
    if (voice) utterance.voice = voice;
  } else {
    window.speechSynthesis.onvoiceschanged = () => {
      voicesLoaded = true;
      const voice = pickNiceVoice();
      if (voice) utterance.voice = voice;
    };
  }

  utterance.onstart = () => {
    isSpeaking = true;
    speakingIndicator.classList.remove("hidden");
  };

  utterance.onend = () => {
    isSpeaking = false;
    speakingIndicator.classList.add("hidden");
    setUiState();
  };

  utterance.onerror = (e) => {
    log("TTS error: " + e.error, true);
    isSpeaking = false;
    speakingIndicator.classList.add("hidden");
    setUiState();
  };

  window.speechSynthesis.speak(utterance);
}

// ================= STT: SPEECH RECOGNITION =================

function initSTT() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    log(
      "Browser does not support SpeechRecognition (STT). Use a recent Chrome-based browser.",
      true
    );
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = false;      // one utterance per click
  recognition.interimResults = false;  // we only care about final result

  recognition.onstart = () => {
    recognizing = true;
    log("Listening...");
    setUiState();
  };

  recognition.onresult = (event) => {
    const result = event.results[0];
    if (!result) return;
    const transcript = (result[0] && result[0].transcript || "").trim();
    if (!transcript) return;

    handleUserUtterance(transcript);
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      log("No speech detected.", false);
    } else {
      log("STT error: " + event.error, true);
    }
  };

  recognition.onend = () => {
    recognizing = false;
    log("Stopped listening.");
    setUiState();
  };
}

function startListeningOnce() {
  if (!recognition) {
    initSTT();
  }
  if (!recognition) return;

  // If Praxis is speaking, cancel the voice FIRST (manual barge-in via button)
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  isSpeaking = false;
  speakingIndicator.classList.add("hidden");

  if (!recognizing) {
    try {
      recognition.start();
    } catch (e) {
      console.error(e);
    }
  }
}

// ================= WS: TALKING TO BACKEND =================

function makeRequestId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

function sendUserTextOverWS(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !wsReady) {
    log("WebSocket not ready; cannot send message.", true);
    return;
  }
  const requestId = makeRequestId();
  lastRequestId = requestId;
  ws.send(
    JSON.stringify({
      type: "user_text",
      text,
      requestId,
    })
  );
}

function handleUserUtterance(transcript) {
  log(`You: ${transcript}`);
  addTranscriptLine("user", transcript);
  conversationHistory.push({ role: "user", text: transcript });

  sendUserTextOverWS(transcript);
}

// ================= SESSION CONTROL =================

function startSession() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email.", true);
    return;
  }

  transcriptEl.textContent = "Transcript will appear here...";
  logsEl.textContent = "";
  conversationHistory = [];
  wsReady = false;
  sessionActive = true;
  lastRequestId = null;

  setUiState();

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
      log("Session ready.");
      wsReady = true;
      setUiState();

      // Optional: ask Praxis to introduce itself (one-time)
      const introPrompt =
        "Introduce yourself as Praxis, my online tutor at Pluralcode Academy, in 2-3 short spoken sentences. Do NOT use bullet points or markdown.";
      const introId = "intro-" + makeRequestId();
      lastRequestId = introId;
      ws.send(
        JSON.stringify({
          type: "user_text",
          text: introPrompt,
          requestId: introId,
        })
      );
      return;
    }

    if (msg.type === "assistant_text") {
      // Optionally ignore stale requestIds if you want; here it's simple
      const aiText = msg.text || "";
      log("Praxis replied.");
      addTranscriptLine("assistant", aiText);
      conversationHistory.push({ role: "assistant", text: aiText });
      speakText(aiText);
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
    wsReady = false;
    sessionActive = false;

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    isSpeaking = false;
    speakingIndicator.classList.add("hidden");

    setUiState();
  };
}

function stopSession() {
  if (recognition && recognizing) {
    recognition.stop();
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  isSpeaking = false;
  speakingIndicator.classList.add("hidden");

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

  sessionActive = false;
  wsReady = false;
  setUiState();

  log("Session stopped.");
}

// ================= EVENT LISTENERS =================

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

talkBtn.addEventListener("click", () => {
  if (!sessionActive || !wsReady) return;
  startListeningOnce();
});

window.addEventListener("beforeunload", () => {
  stopSession();
});
