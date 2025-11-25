// ================= CONFIG =================

// Assuming frontend is served by the same server.js (same origin)
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
let wsReady = false;

let recognition = null;
let recognizing = false;
let shouldKeepListening = false;

let currentTtsText = "";  // lowercased text currently being spoken
let voicesLoaded = false;

let conversationHistory = [];  // just for UI
let lastRequestId = null;

// ================= UTIL: LOGGING =================

function log(msg, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = "log-entry" + (isError ? " error" : "");
  div.textContent = `[${timestamp}] ${msg}`;
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
  console[isError ? "error" : "log"](msg);
}

// ================= UTIL: TRANSCRIPT UI =================

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

// ================= TTS: SPEAKING =================

function sanitizeForSpeech(fullText) {
  if (!fullText) return "";

  let text = fullText;

  // Optional: cut off "Links:" / "Resources:" section so it doesn't read URLs
  const cutIndex = text.search(/(links:|resources:)/i);
  if (cutIndex !== -1) {
    text = text.slice(0, cutIndex);
  }

  // Remove markdown symbols (*, _, `, #, -, > etc)
  text = text.replace(/[*_`>#\-]+/g, " ");

  // Fix some pronunciations (example: Excel)
  text = text.replace(/\bExcel\b/gi, "Microsoft Excel");

  // Collapse extra spaces
  text = text.replace(/\s{2,}/g, " ");

  return text.trim();
}

function pickNiceVoice() {
  const allVoices = window.speechSynthesis.getVoices();
  if (!allVoices || !allVoices.length) return null;

  // Prefer Google voices if available (often more natural)
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

  // Slightly slower, normal pitch
  utterance.rate = 0.95;
  utterance.pitch = 1.0;

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
    speakingIndicator.classList.remove("hidden");
    currentTtsText = spoken.toLowerCase();
  };

  utterance.onend = () => {
    speakingIndicator.classList.add("hidden");
    currentTtsText = "";
  };

  utterance.onerror = (e) => {
    log("TTS error: " + e.error, true);
    speakingIndicator.classList.add("hidden");
    currentTtsText = "";
  };

  window.speechSynthesis.speak(utterance);
}

// ================= STT: LISTENING =================

function initSTT() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log(
      "Browser does not support SpeechRecognition (STT). Use Chrome-based browser.",
      true
    );
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onstart = () => {
    recognizing = true;
    log("Listening...");
  };

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;

      const transcript = result[0].transcript.trim();
      if (!transcript) continue;

      // ---- ECHO FILTER ----
      const words = transcript.split(/\s+/);
      if (
        currentTtsText &&
        words.length > 4 &&
        currentTtsText.includes(transcript.toLowerCase())
      ) {
        console.log("Ignoring echo transcript:", transcript);
        return;
      }

      // Real user speech:
      handleUserUtterance(transcript);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "network") {
      console.log("STT benign error:", event.error);
      if (shouldKeepListening) {
        setTimeout(() => {
          if (!recognizing) {
            try {
              recognition.start();
            } catch (_) {}
          }
        }, 500);
      }
      return;
    }
    log("STT error: " + event.error, true);
  };

  recognition.onend = () => {
    recognizing = false;
    if (shouldKeepListening) {
      setTimeout(() => {
        try {
          recognition.start();
        } catch (_) {}
      }, 400);
    }
  };
}

function startListening() {
  if (!recognition) initSTT();
  if (recognition && !recognizing) {
    try {
      recognition.start();
    } catch (e) {
      console.error(e);
    }
  }
}

function stopListening() {
  shouldKeepListening = false;
  if (recognition && recognizing) {
    recognition.stop();
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

  // If AI is talking, interrupt it
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  currentTtsText = "";
  speakingIndicator.classList.add("hidden");

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
  lastRequestId = null;

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
      log("Session ready. Start speaking when you're ready.");
      wsReady = true;
      shouldKeepListening = true;
      startListening();
      // ❌ REMOVED: automatic intro prompt
      return;
    }

    if (msg.type === "assistant_text") {
      // Ignore stale responses (from older interrupted requests)
      if (
        msg.requestId &&
        lastRequestId &&
        msg.requestId !== lastRequestId
      ) {
        console.log("Ignoring stale response:", msg.requestId);
        return;
      }

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
    stopListening();

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    currentTtsText = "";
    speakingIndicator.classList.add("hidden");

    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  };
}

function stopSession() {
  shouldKeepListening = false;
  stopListening();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  currentTtsText = "";
  speakingIndicator.classList.add("hidden");

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

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
