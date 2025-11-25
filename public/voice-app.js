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

const resourcesEl = document.getElementById("resources");
const quizContainer = document.getElementById("quizContainer");

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

  // Talk is only enabled when session is active, WS ready, and not currently listening
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

// ================= QUIZ HELPERS =================

function extractQuizDefinition(fullText) {
  const match = fullText.match(
    /\[QUIZ_JSON_START\]([\s\S]+?)\[QUIZ_JSON_END\]/
  );
  if (!match) return null;
  try {
    const json = match[1].trim();
    const quiz = JSON.parse(json);
    if (!quiz || !Array.isArray(quiz.questions)) return null;
    return quiz;
  } catch (e) {
    console.error("Failed to parse quiz JSON:", e);
    return null;
  }
}

function stripQuizJson(fullText) {
  return fullText
    .replace(/\[QUIZ_JSON_START\][\s\S]+?\[QUIZ_JSON_END\]/, "")
    .trim();
}

function renderQuiz(quizDef) {
  quizContainer.innerHTML = "";

  if (!quizDef || !Array.isArray(quizDef.questions) || !quizDef.questions.length) {
    const p = document.createElement("p");
    p.textContent = "Quiz format error. Try asking Praxis for another quiz.";
    quizContainer.appendChild(p);
    return;
  }

  const intro = document.createElement("p");
  intro.textContent = "Quiz loaded. Answer the questions and click Submit to see your score.";
  quizContainer.appendChild(intro);

  quizDef.questions.forEach((q, idx) => {
    const qDiv = document.createElement("div");
    qDiv.className = "quiz-question";

    const qText = document.createElement("p");
    qText.textContent = `${idx + 1}. ${q.q}`;
    qDiv.appendChild(qText);

    if (!Array.isArray(q.options)) q.options = [];

    q.options.forEach((opt, optIdx) => {
      const label = document.createElement("label");
      label.className = "quiz-option";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `quiz_q_${idx}`;
      radio.value = String(optIdx);

      label.appendChild(radio);
      label.appendChild(document.createTextNode(" " + opt));
      qDiv.appendChild(label);
    });

    quizContainer.appendChild(qDiv);
  });

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Submit Quiz";
  submitBtn.className = "btn btn-primary quiz-submit-btn";

  const resultP = document.createElement("p");
  resultP.className = "quiz-result";

  submitBtn.addEventListener("click", () => {
    let correct = 0;
    const total = quizDef.questions.length;

    quizDef.questions.forEach((q, idx) => {
      const selected = quizContainer.querySelector(
        `input[name="quiz_q_${idx}"]:checked`
      );
      if (!selected) return;
      const chosen = Number(selected.value);
      if (Number(q.answerIndex) === chosen) correct++;
    });

    resultP.textContent = `You scored ${correct} out of ${total}.`;
  });

  quizContainer.appendChild(submitBtn);
  quizContainer.appendChild(resultP);
}

// ================= RESOURCES / YOUTUBE =================

function extractLinks(text) {
  return text.match(/https?:\/\/\S+/gi) || [];
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "");
    }
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v");
    }
  } catch (e) {
    return null;
  }
  return null;
}

function renderResourcesFromText(text) {
  const links = extractLinks(text);
  if (!links.length) return;

  // Remove placeholder if it's still there
  const placeholder = resourcesEl.querySelector(".placeholder");
  if (placeholder) {
    placeholder.remove();
  }

  links.forEach((url) => {
    const card = document.createElement("div");
    card.className = "resource-card";

    const linkEl = document.createElement("a");
    linkEl.href = url;
    linkEl.target = "_blank";
    linkEl.rel = "noopener noreferrer";
    linkEl.textContent = url;
    card.appendChild(linkEl);

    // If YouTube link, embed preview
    if (/youtube\.com\/watch|youtu\.be\//i.test(url)) {
      const videoId = extractYouTubeId(url);
      if (videoId) {
        const iframe = document.createElement("iframe");
        iframe.src = `https://www.youtube.com/embed/${videoId}`;
        iframe.allow =
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
        iframe.allowFullscreen = true;
        iframe.loading = "lazy";
        iframe.width = "100%";
        iframe.height = "200";
        card.appendChild(iframe);
      }
    }

    resourcesEl.appendChild(card);
  });
}

// ================= TTS: SPEECH SYNTHESIS =================

function sanitizeForSpeech(fullText) {
  if (!fullText) return "";

  let text = fullText;

  // Remove any quiz JSON if somehow still present
  text = stripQuizJson(text);

  // Strip markdown bullets / formatting symbols
  text = text.replace(/[*_`>#]+/g, " ");

  // Remove comment-like slashes and bracket-ish characters
  text = text.replace(/\/\/+/g, " ");
  text = text.replace(/[{}\[\]()/\\|~^]+/g, " ");

  // Try to drop "Links:" / "Resources:" sections from speech
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

  // Try to bias towards male-ish voices by name
  const preferredNamePatterns = [
    /male/i,
    /\bDavid\b/i,
    /\bDaniel\b/i,
    /\bAlex\b/i,
    /\bGeorge\b/i,
    /\bTom\b/i,
  ];

  let preferred = allVoices.find((v) =>
    preferredNamePatterns.some((rx) => rx.test(v.name))
  );

  if (!preferred) {
    preferred =
      allVoices.find((v) => /Google US English\b/i.test(v.name)) ||
      allVoices.find((v) => /Google UK English\b/i.test(v.name)) ||
      allVoices.find((v) => /Google/i.test(v.name));
  }

  return preferred || allVoices[0];
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
  utterance.rate = 0.9;
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
  recognition.interimResults = false;  // only final result

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
  resourcesEl.innerHTML =
    '<p class="placeholder">Links and YouTube previews will appear here when Praxis shares resources.</p>';
  quizContainer.innerHTML =
    '<p class="placeholder">No quiz yet. Ask Praxis to test you with a short quiz.</p>';

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

      // Optional: ask Praxis to introduce himself
      const introPrompt =
        "Introduce yourself as Praxis, my male online tutor at Pluralcode Academy, in 2-3 short spoken sentences. Do NOT use bullet points or markdown.";
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
      const fullText = msg.text || "";

      // Extract quiz if present
      const quizDef = extractQuizDefinition(fullText);
      if (quizDef) {
        renderQuiz(quizDef);
      }

      // Strip quiz JSON for display & speech
      const displayText = stripQuizJson(fullText);

      log("Praxis replied.");
      addTranscriptLine("assistant", displayText);
      conversationHistory.push({ role: "assistant", text: displayText });

      // Render resources (YouTube previews, links)
      renderResourcesFromText(displayText);

      // Speak explanation only (no quiz / weird characters)
      speakText(displayText);
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
