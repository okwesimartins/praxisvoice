// ================= CONFIG =================

const WS_URL =
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

// ================= DOM ELEMENTS =================

const emailInput = document.getElementById("email");
const lmsKeyInput = document.getElementById("lmsKey");
const startBtn = document.getElementById("startBtn");
const talkBtn = document.getElementById("talkBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptEl = document.getElementById("transcript");
const logsEl = document.getElementById("logs");
const speakingIndicator = document.getElementById("speakingIndicator");
const quizArea = document.getElementById("quizArea");
const quizScoreEl = document.getElementById("quizScore");

// ================= STATE =================

let ws = null;
let wsReady = false;

let recognition = null;
let isListening = false;
let talkModeActive = false;

let currentAudio = null;
let conversationHistory = [];

let lastRequestId = null;

// Quiz score
let quizCorrect = 0;
let quizTotal = 0;

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
  if (
    transcriptEl.textContent.trim() === "Transcript will appear here..."
  ) {
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
  const videoId = getYouTubeIdFromUrl(url);
  if (!videoId) return;
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
  transcriptEl.appendChild(card);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ================= QUIZ PARSING & RENDER =================

function extractQuizzesFromText(text) {
  const quizzes = [];
  if (!text) return { cleanText: text, quizzes };

  let cleanText = text;
  const regex = /QUIZ:\s*({[^}]*})/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const jsonStr = match[1];
    try {
      const quiz = JSON.parse(jsonStr);
      if (
        quiz &&
        typeof quiz.question === "string" &&
        Array.isArray(quiz.options) &&
        typeof quiz.correctIndex === "number"
      ) {
        quizzes.push(quiz);
      }
    } catch (e) {
      console.warn("Failed to parse QUIZ JSON:", e);
    }
  }

  cleanText = cleanText.replace(/QUIZ:\s*{[^}]*}/gi, "").trim();
  return { cleanText, quizzes };
}

function updateQuizScoreDisplay() {
  if (quizTotal === 0) {
    quizScoreEl.textContent = "No quizzes completed yet.";
  } else {
    quizScoreEl.textContent = `Score: ${quizCorrect}/${quizTotal} correct`;
  }
}

function renderQuiz(quiz) {
  const card = document.createElement("div");
  card.className = "quiz-card";

  const questionEl = document.createElement("div");
  questionEl.className = "quiz-question";
  questionEl.textContent = quiz.question;
  card.appendChild(questionEl);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "quiz-options";

  const name = "quiz-" + Date.now() + "-" + Math.random().toString(36).slice(2);

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

// ================= AUDIO PLAYBACK (Google TTS MP3) =================

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  speakingIndicator.classList.add("hidden");
}

function playAssistantAudio(base64Audio, mimeType) {
  stopCurrentAudio();
  if (!base64Audio) return;

  try {
    const src = `data:${mimeType || "audio/mpeg"};base64,${base64Audio}`;
    const audio = new Audio(src);
    currentAudio = audio;

    audio.onplay = () => {
      speakingIndicator.classList.remove("hidden");
    };

    audio.onended = () => {
      speakingIndicator.classList.add("hidden");
      currentAudio = null;
    };

    audio.onerror = (e) => {
      console.error("Audio playback error:", e);
      speakingIndicator.classList.add("hidden");
      currentAudio = null;
    };

    audio.play().catch((err) => {
      console.error("Audio play() failed:", err);
      speakingIndicator.classList.add("hidden");
      currentAudio = null;
    });
  } catch (e) {
    console.error("Failed to create audio element:", e);
  }
}

// ================= STT: LISTENING (talkMode stays on) =================

function initSTT() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    log(
      "Browser does not support SpeechRecognition (STT). Use Chrome-based browser.",
      true
    );
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = true;        // keep stream open
  rec.interimResults = false;   // only final results

  rec.onstart = () => {
    isListening = true;
    log("Listening for your question...");
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
      handleUserUtterance(text);
    }
  };

  rec.onerror = (event) => {
    console.error("STT error:", event);
    // If it's no-speech or network, and talk mode is active, just restart
    if (event.error === "no-speech" || event.error === "network") {
      if (talkModeActive) {
        setTimeout(() => {
          if (!isListening) {
            try {
              rec.start();
            } catch (_) {}
          }
        }, 400);
      }
      return;
    }
    log("STT error: " + event.error, true);
  };

  rec.onend = () => {
    isListening = false;
    // If talk mode is still active, restart listening so the mic stays open
    if (talkModeActive) {
      setTimeout(() => {
        try {
          rec.start();
        } catch (e) {
          console.error("STT restart error:", e);
        }
      }, 300);
    } else {
      talkBtn.classList.remove("listening");
      talkBtn.textContent = "🎤 Talk to Praxis";
    }
  };

  return rec;
}

function ensureSTTAndStart() {
  if (!recognition) {
    recognition = initSTT();
  }
  if (!recognition) return;

  if (!isListening) {
    try {
      recognition.start();
    } catch (e) {
      console.error("recognition.start error:", e);
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

  // Once user talks, stop any current AI speech (manual barge-in)
  stopCurrentAudio();

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
  quizArea.innerHTML = "";
  quizScoreEl.textContent = "";
  quizCorrect = 0;
  quizTotal = 0;
  conversationHistory = [];
  wsReady = false;
  lastRequestId = null;
  talkModeActive = false;
  isListening = false;

  emailInput.disabled = true;
  lmsKeyInput.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  talkBtn.disabled = true;
  talkBtn.classList.remove("listening");
  talkBtn.textContent = "🎤 Talk to Praxis";

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

  ws.onclose = () => {
    log("WebSocket closed.");
    wsReady = false;
    stopCurrentAudio();

    // Stop STT mode
    talkModeActive = false;
    if (recognition && isListening) {
      recognition.stop();
    }
    isListening = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎤 Talk to Praxis";

    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    talkBtn.disabled = true;
  };
}

function stopSession() {
  stopCurrentAudio();

  talkModeActive = false;
  if (recognition && isListening) {
    recognition.stop();
  }
  isListening = false;
  talkBtn.classList.remove("listening");
  talkBtn.textContent = "🎤 Talk to Praxis";

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

  // If AI is currently speaking, interrupt it first
  if (currentAudio) {
    stopCurrentAudio();
  }

  // Toggle talk mode
  if (!talkModeActive) {
    talkModeActive = true;
    log("Listening mode ON. Speak whenever you're ready.");
    ensureSTTAndStart();
  } else {
    talkModeActive = false;
    log("Listening mode OFF.");
    if (recognition && isListening) {
      recognition.stop();
    }
    isListening = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎤 Talk to Praxis";
  }
}

// ================= EVENT LISTENERS =================

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
talkBtn.addEventListener("click", handleTalkClick);

window.addEventListener("beforeunload", () => {
  stopSession();
});
