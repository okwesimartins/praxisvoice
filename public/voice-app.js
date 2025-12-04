// ================= CONFIG =================

const WS_URL ="wss://veritas-ai-voice-156084498565.europe-west1.run.app/ws";

// ================= DOM ELEMENTS =================

const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const talkBtn = document.getElementById("talkBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");

const resourcesEl = document.getElementById("resources");
const quizArea = document.getElementById("quizContainer");
const quizScoreEl = document.getElementById("quizScore");

// ================= STATE =================

let ws = null;
let wsReady = false;
let heartbeatInterval = null;   // client heartbeat

let recognition = null;
let sttActive = false;
let talkSessionActive = false;
let hasHeardSpeech = false;
let speechBuffer = "";
let silenceTimer = null;

// Web Audio (for iOS-safe TTS)
let audioCtx = null;
let currentAudioSource = null;
let audioCtxReady = false;

let conversationHistory = [];

let lastRequestId = null;

// quiz score
let quizCorrect = 0;
let quizTotal = 0;

// WS reconnect state
let sessionActive = false;
let manualClose = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let activeEmail = "";
let activeLmsKey = "";

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
  if (!text) return;
  const line = document.createElement("div");
  line.className = "transcript-line " + role; // "user" or "assistant"
  line.textContent = (role === "user" ? "You: " : "Praxis: ") + text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ================= YOUTUBE PREVIEW =================

function extractYoutubeLinks(text) {
  const links = [];
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    let url = match[1];
    url = url.replace(/[),.]+$/, "");
    if (url.includes("youtube.com/watch") || url.includes("youtu.be")) {
      links.push(url);
    }
  }
  return links;
}

function getYouTubeIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v");
    }
  } catch (e) {
    return null;
  }
  return null;
}

function renderYoutubePreview(url) {
  if (!resourcesEl) return;

  const videoId = getYouTubeIdFromUrl(url);
  if (!videoId) return;

  const ph = resourcesEl.querySelector(".placeholder");
  if (ph) ph.remove();

  const card = document.createElement("div");
  card.className = "yt-card";
  card.innerHTML = `
    <a href="${url}" target="_blank" rel="noopener noreferrer" class="yt-thumb-link">
      <img src="https://img.youtube.com/vi/${videoId}/hqdefault.jpg" class="yt-thumb" alt="YouTube thumbnail" />
      <div class="yt-meta">
        <div class="yt-title">YouTube video</div>
        <div class="yt-url">${url}</div>
      </div>
    </a>
  `;
  resourcesEl.appendChild(card);
}

// ================= QUIZ PARSING & RENDER =================

function extractQuizzesFromText(text) {
  const quizzes = [];
  if (!text) return { cleanText: text, quizzes };

  const lines = text.split(/\r?\n/);
  const keptLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // We treat any line that STARTS with "QUIZ:" as a quiz line
    if (trimmed.toUpperCase().startsWith("QUIZ:")) {
      const jsonPart = trimmed.slice(5).trim(); // remove "QUIZ:"

      try {
        const quiz = JSON.parse(jsonPart);
        if (
          quiz &&
          typeof quiz.question === "string" &&
          Array.isArray(quiz.options) &&
          quiz.options.length === 4 &&
          typeof quiz.correctIndex === "number"
        ) {
          quizzes.push(quiz);
          continue; // don't keep this line in the transcript
        }
      } catch (e) {
        console.warn("Failed to parse QUIZ JSON line:", trimmed, e);
        // fall through and keep the line as normal text if parsing fails
      }
    }

    // Not a valid QUIZ line → keep it as part of the transcript
    keptLines.push(line);
  }

  const cleanText = keptLines.join("\n").trim();
  return { cleanText, quizzes };
}

function updateQuizScoreDisplay() {
  if (!quizScoreEl) return;
  if (quizTotal === 0) {
    quizScoreEl.textContent = "No quizzes completed yet.";
  } else {
    quizScoreEl.textContent = `Score: ${quizCorrect}/${quizTotal} correct`;
  }
}

function renderQuiz(quiz) {
  if (!quizArea) return;

  const ph = quizArea.querySelector(".placeholder");
  if (ph) ph.remove();

  const card = document.createElement("div");
  card.className = "quiz-card";

  const questionEl = document.createElement("div");
  questionEl.className = "quiz-question";
  questionEl.textContent = quiz.question;
  card.appendChild(questionEl);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "quiz-options";

  const name =
    "quiz-" + Date.now() + "-" + Math.random().toString(36).slice(2);

  quiz.options.forEach((opt, idx) => {
    const optId = `${name}-${idx}`;

    const label = document.createElement("label");
    label.className = "quiz-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = idx;
    input.id = optId;

    const span = document.createElement("span");
    span.textContent = opt;

    label.appendChild(input);
    label.appendChild(span);
    optionsWrap.appendChild(label);
  });

  card.appendChild(optionsWrap);

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn-primary quiz-submit";
  submitBtn.textContent = "Submit answer";

  const feedbackEl = document.createElement("div");
  feedbackEl.className = "quiz-feedback";

  submitBtn.addEventListener("click", () => {
    const selected = card.querySelector("input[type=radio]:checked");
    if (!selected) {
      feedbackEl.textContent = "Please choose an option.";
      feedbackEl.classList.remove("correct", "incorrect");
      return;
    }

    const chosenIndex = parseInt(selected.value, 10);
    quizTotal += 1;
    if (chosenIndex === quiz.correctIndex) {
      quizCorrect += 1;
      feedbackEl.textContent = "Correct! " + (quiz.explanation || "");
      feedbackEl.classList.remove("incorrect");
      feedbackEl.classList.add("correct");
    } else {
      const correctLabel = quiz.options[quiz.correctIndex] || "";
      feedbackEl.textContent =
        `Not quite. Correct answer: ${correctLabel}. ` +
        (quiz.explanation || "");
      feedbackEl.classList.remove("correct");
      feedbackEl.classList.add("incorrect");
    }
    updateQuizScoreDisplay();
    submitBtn.disabled = true;
  });

  card.appendChild(submitBtn);
  card.appendChild(feedbackEl);

  quizArea.appendChild(card);
  updateQuizScoreDisplay();
}

// ================= AUDIO: Web Audio API (iOS-friendly TTS) =================

function ensureAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      log(
        "Web Audio API not supported; audio playback may not work on this device.",
        true
      );
      return null;
    }
    audioCtx = new AC();
  }

  if (audioCtx.state === "suspended") {
    audioCtx
      .resume()
      .then(() => {
        audioCtxReady = true;
        console.log("AudioContext resumed");
      })
      .catch((err) => {
        console.error("AudioContext resume failed:", err);
        log("Unable to resume audio context: " + err.message, true);
      });
  } else {
    audioCtxReady = true;
  }

  return audioCtx;
}

function stopCurrentAudio() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (_) {}
    try {
      currentAudioSource.disconnect();
    } catch (_) {}
    currentAudioSource = null;
  }
  speakingIndicator.classList.add("hidden");
}

async function playAssistantAudio(base64Audio, mimeType) {
  stopCurrentAudio();
  if (!base64Audio) return;

  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    // Decode base64 → ArrayBuffer
    const binary = atob(base64Audio);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    source.onended = () => {
      speakingIndicator.classList.add("hidden");
      currentAudioSource = null;
    };

    speakingIndicator.classList.remove("hidden");
    currentAudioSource = source;
    source.start(0);
  } catch (err) {
    console.error("WebAudio playback failed:", err);
    log("Audio playback failed: " + err.message, true);
    speakingIndicator.classList.add("hidden");
    currentAudioSource = null;
  }
}

// ================= STT: PUSH-TO-TALK with silence detection =================

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

function resetSilenceTimer() {
  clearSilenceTimer();
  if (!talkSessionActive || !sttActive || !hasHeardSpeech) return;
  silenceTimer = setTimeout(() => {
    if (talkSessionActive && sttActive && hasHeardSpeech && recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.error("recognition.stop() in silenceTimer failed:", e);
      }
    }
  }, 2500); // ~2.5s of silence after you've spoken
}

function initSTT() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log(
      "Browser does not support SpeechRecognition (STT). Use a Chrome-based browser.",
      true
    );
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = false;

  rec.onstart = () => {
    sttActive = true;
    log("Listening... start speaking when you're ready.");
    talkBtn.classList.add("listening");
    talkBtn.textContent = "Stop Listening";
  };

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const transcript = (result[0] && result[0].transcript) || "";
      const text = transcript.trim();
      if (!text) continue;

      hasHeardSpeech = true;

      if (speechBuffer.length) {
        speechBuffer += " " + text;
      } else {
        speechBuffer = text;
      }

      resetSilenceTimer();
    }
  };

  rec.onerror = (event) => {
    console.error("STT error:", event);

    if (event.error === "no-speech" && talkSessionActive && !hasHeardSpeech) {
      // user clicked Talk but didn't speak; keep session alive
      return;
    }

    talkSessionActive = false;
    hasHeardSpeech = false;
    sttActive = false;
    clearSilenceTimer();
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";
    if (event.error !== "aborted") {
      log("STT error: " + event.error, true);
    }
  };

  rec.onend = () => {
    sttActive = false;

    // If user never spoke, keep listening session alive
    if (!talkSessionActive) {
      clearSilenceTimer();
      speechBuffer = "";
      hasHeardSpeech = false;
      talkBtn.classList.remove("listening");
      talkBtn.textContent = "🎙️ Talk";
      return;
    }

    if (talkSessionActive && !hasHeardSpeech) {
      setTimeout(() => {
        if (talkSessionActive && !sttActive) {
          try {
            recognition.start();
          } catch (e) {
            console.error("STT restart error:", e);
            talkSessionActive = false;
            talkBtn.classList.remove("listening");
            talkBtn.textContent = "🎙️ Talk";
          }
        }
      }, 250);
      return;
    }

    // If we *have* heard speech, this end means "user finished speaking"
    talkSessionActive = false;
    clearSilenceTimer();
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";

    const finalText = speechBuffer.trim();
    speechBuffer = "";
    hasHeardSpeech = false;

    if (finalText) {
      handleUserUtterance(finalText);
    } else {
      log("No speech captured.", true);
    }
  };

  return rec;
}

function startTalkSession() {
  if (!recognition) {
    recognition = initSTT();
  }
  if (!recognition) return;
  if (sttActive) return;

  talkSessionActive = true;
  hasHeardSpeech = false;
  speechBuffer = "";
  clearSilenceTimer();

  try {
    recognition.start();
  } catch (e) {
    console.error("recognition.start error:", e);
    talkSessionActive = false;
    hasHeardSpeech = false;
    sttActive = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";
  }
}

function cancelTalkSession() {
  talkSessionActive = false;
  hasHeardSpeech = false;
  clearSilenceTimer();

  if (recognition && sttActive) {
    try {
      recognition.stop();
    } catch (e) {
      console.error("recognition.stop error:", e);
    }
  }

  sttActive = false;
  talkBtn.classList.remove("listening");
  talkBtn.textContent = "🎙️ Talk";
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

  // manual barge-in: stop any AI speech
  stopCurrentAudio();

  sendUserTextOverWS(transcript);
}

function openWebSocket() {
  if (!activeEmail) {
    log("Cannot open WebSocket: missing activeEmail", true);
    return;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    log("WebSocket connected. Sending start...");
    wsReady = true;
    reconnectAttempts = 0;

    ws.send(
      JSON.stringify({
        type: "start",
        student_email: activeEmail,
        lmsKey: activeLmsKey || undefined,
        history: conversationHistory,
      })
    );

    // client heartbeat
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }, 20000);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error("WS parse error:", e);
      return;
    }

    if (msg.type === "pong") {
      return;
    }

    if (msg.type === "ready") {
      log("Session ready. You can now talk to Praxis.");
      wsReady = true;
      talkBtn.disabled = false;
      return;
    }

    if (msg.type === "assistant_text") {
      const aiText = msg.text || "";
      log("Praxis replied.");
      const { cleanText, quizzes } = extractQuizzesFromText(aiText);

      if (cleanText) {
        addTranscriptLine("assistant", cleanText);
        conversationHistory.push({ role: "assistant", text: cleanText });

        const ytLinks = extractYoutubeLinks(cleanText);
        ytLinks.forEach(renderYoutubePreview);
      }

      quizzes.forEach(renderQuiz);

      if (msg.audio) {
        playAssistantAudio(msg.audio, msg.audioMime);
      }
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

  ws.onclose = (event) => {
    wsReady = false;

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    cancelTalkSession();

    log(
      `WebSocket closed (code=${event.code}, reason="${event.reason || ""}")`
    );

    if (
      sessionActive &&
      !manualClose &&
      reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      reconnectAttempts += 1;
      const delayMs = 1000 * Math.pow(2, reconnectAttempts - 1);

      log(
        `Connection lost. Attempting to reconnect in ${delayMs / 1000} seconds...`
      );

      talkBtn.disabled = true;

      setTimeout(() => {
        if (sessionActive && !manualClose) {
          openWebSocket();
        }
      }, delayMs);
      return;
    }

    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    talkBtn.disabled = true;
  };
}

// ================= SESSION CONTROL =================

function startSession() {
  const email = emailInput.value.trim();
  if (!email) {
    log("Please enter student email.", true);
    return;
  }

  // Unlock audio on a real user gesture (important for iOS)
  ensureAudioContext();

  activeEmail = email;
  activeLmsKey = lmsKeyInput.value.trim() || "";
  sessionActive = true;
  manualClose = false;
  reconnectAttempts = 0;

  transcriptEl.textContent = "Transcript will appear here...";
  logsEl.textContent = "";

  if (resourcesEl) {
    resourcesEl.innerHTML =
      '<p class="placeholder">Links and YouTube previews will appear here when Praxis shares resources.</p>';
  }
  if (quizArea) {
    quizArea.innerHTML =
      '<p class="placeholder">No quiz yet. Ask Praxis to test you with a short quiz.</p>';
  }
  if (quizScoreEl) {
    quizScoreEl.textContent = "No quizzes completed yet.";
  }

  quizCorrect = 0;
  quizTotal = 0;
  conversationHistory = [];
  wsReady = false;
  lastRequestId = null;

  cancelTalkSession();

  emailInput.disabled = true;
  lmsKeyInput.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  talkBtn.disabled = true;

  log("Connecting WebSocket...");
  openWebSocket();
}

function stopSession() {
  stopCurrentAudio();
  cancelTalkSession();

  sessionActive = false;
  manualClose = true;

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }

  emailInput.disabled = false;
  lmsKeyInput.disabled = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  talkBtn.disabled = true;

  log("Session stopped.");
}

// ================= BUTTON HANDLERS =================

function handleTalkClick() {
  if (!wsReady) {
    log("Session not ready yet.", true);
    return;
  }

  // make sure audio context is resumed on this gesture (iOS)
  ensureAudioContext();

  // If AI is currently speaking, interrupt it first
  if (currentAudioSource) {
    stopCurrentAudio();
  }

  if (!talkSessionActive && !sttActive) {
    log("Listening mode ON. Start speaking when you're ready.");
    startTalkSession();
  } else {
    log("Listening mode OFF.");
    cancelTalkSession();
  }
}

// ================= EVENT LISTENERS =================

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
talkBtn.addEventListener("click", handleTalkClick);

window.addEventListener("beforeunload", () => {
  stopSession();
});
