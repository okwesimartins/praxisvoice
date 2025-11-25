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

const resourcesEl = document.getElementById("resources");
const quizArea = document.getElementById("quizContainer");
const quizScoreEl = document.getElementById("quizScore");

// ================= STATE =================

let ws = null;
let wsReady = false;

let recognition = null;
let sttActive = false;          // browser recognition currently running
let talkSessionActive = false;  // "I pressed Talk and I'm expecting speech"
let hasHeardSpeech = false;     // did this talk session get any final transcript?

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
    // strip trailing punctuation
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

  // remove placeholder once we have first resource
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
  if (!quizScoreEl) return;
  if (quizTotal === 0) {
    quizScoreEl.textContent = "No quizzes completed yet.";
  } else {
    quizScoreEl.textContent = `Score: ${quizCorrect}/${quizTotal} correct`;
  }
}

function renderQuiz(quiz) {
  if (!quizArea) return;

  // remove placeholder on first quiz
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

// ================= STT: PUSH-TO-TALK (one utterance) =================

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
  rec.continuous = false;      // ONE utterance per start()
  rec.interimResults = false;  // only final results

  rec.onstart = () => {
    sttActive = true;
    log("Listening... start speaking.");
    talkBtn.classList.add("listening");
    talkBtn.textContent = "Stop Listening";
  };

  rec.onresult = (event) => {
    let finalTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      }
    }
    finalTranscript = finalTranscript.trim();
    if (finalTranscript) {
      hasHeardSpeech = true;
      handleUserUtterance(finalTranscript);
    }
  };

  rec.onerror = (event) => {
    console.error("STT error:", event);
    // If no-speech while we're still waiting for the user to talk, let onend handle restart.
    if (event.error === "no-speech" && talkSessionActive && !hasHeardSpeech) {
      return;
    }
    // Any other error: end this talk session
    talkSessionActive = false;
    hasHeardSpeech = false;
    sttActive = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";
    if (event.error !== "aborted") {
      log("STT error: " + event.error, true);
    }
  };

  rec.onend = () => {
    sttActive = false;

    // If user pressed Talk and we haven't heard speech yet, keep listening.
    if (talkSessionActive && !hasHeardSpeech) {
      setTimeout(() => {
        if (talkSessionActive && !sttActive) {
          try {
            rec.start();
          } catch (e) {
            console.error("STT restart error:", e);
            talkSessionActive = false;
            talkBtn.classList.remove("listening");
            talkBtn.textContent = "🎙️ Talk";
          }
        }
      }, 300);
      return;
    }

    // Normal end (we got speech or user cancelled)
    talkSessionActive = false;
    hasHeardSpeech = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";
  };

  return rec;
}

function startOneShotListening() {
  if (!recognition) {
    recognition = initSTT();
  }
  if (!recognition) return;
  if (sttActive) return;

  talkSessionActive = true;
  hasHeardSpeech = false;

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

  // reset STT state
  talkSessionActive = false;
  hasHeardSpeech = false;
  sttActive = false;

  emailInput.disabled = true;
  lmsKeyInput.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  talkBtn.disabled = true;
  talkBtn.classList.remove("listening");
  talkBtn.textContent = "🎙️ Talk";

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

    // Stop any listening session
    talkSessionActive = false;
    hasHeardSpeech = false;
    if (recognition && sttActive) {
      recognition.stop();
    }
    sttActive = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";

    emailInput.disabled = false;
    lmsKeyInput.disabled = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    talkBtn.disabled = true;
  };
}

function stopSession() {
  stopCurrentAudio();

  talkSessionActive = false;
  hasHeardSpeech = false;
  if (recognition && sttActive) {
    recognition.stop();
  }
  sttActive = false;
  talkBtn.classList.remove("listening");
  talkBtn.textContent = "🎙️ Talk";

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

  // If not currently in a talk session, start one-shot listening.
  if (!talkSessionActive && !sttActive) {
    log("Listening mode ON. Start speaking when you're ready.");
    startOneShotListening();
  } else {
    // User clicked again to cancel listening
    log("Listening mode OFF.");
    talkSessionActive = false;
    hasHeardSpeech = false;
    if (recognition && sttActive) {
      recognition.stop();
    }
    sttActive = false;
    talkBtn.classList.remove("listening");
    talkBtn.textContent = "🎙️ Talk";
  }
}

// ================= EVENT LISTENERS =================

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
talkBtn.addEventListener("click", handleTalkClick);

window.addEventListener("beforeunload", () => {
  stopSession();
});
