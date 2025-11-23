/**
 * server.js — Single-file Cloud Run VOICE service for Praxis
 * - WebSocket endpoint: /ws/voice
 * - Enforces student scope via Pluralcode API
 * - Optional LMS API key auth
 * - Bridges browser mic PCM16k <-> Gemini Live (audio + text)
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const crypto = require("crypto");
const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require("@google/generative-ai");
const { google } = require("googleapis");

// ---- fetch polyfill (Node < 18) ----
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => fetchFn(...args);

// ---------------- ENV ----------------
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MY_LMS_API_KEY = process.env.MY_LMS_API_KEY; // optional but recommended

const PLURALCODE_API_BASE =
  process.env.PLURALCODE_API_URL || "https://backend.pluralcode.institute";

const Google_Search_API_KEY = process.env.Google_Search_API_KEY;
const Google_Search_CX_ID = process.env.Google_Search_CX_ID;

// ---------------- EXPRESS ----------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("ok"));

// Serve the test page directly from Cloud Run
app.get("/voice.html", (_, res) => {
  res.type("html").send(VOICE_HTML);
});

// ---------------- HELPERS ----------------
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

const withTimeout = async (promise, ms, msg = "Timed out") => {
  const t = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(msg)), ms)
  );
  return Promise.race([promise, t]);
};

// ---------------- PLURALCODE SCOPE ----------------
// (kept simpler than your big harvest logic, but same idea)
async function getStudentScope(email) {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Student email missing.");

  const url = `${PLURALCODE_API_BASE}/student/praxis_get_student_courses?email=${encodeURIComponent(clean)}`;

  const r = await withTimeout(fetch(url), 8000, "Pluralcode API timeout");
  if (!r.ok) throw new Error("Could not verify student enrollment.");

  const data = await r.json();
  const enrolled = Array.isArray(data.enrolled_courses) ? data.enrolled_courses : [];

  const courseNames = enrolled
    .map((c) => (c.coursename || c.course_name || c.name || c.title || "").trim())
    .filter(Boolean);

  if (!courseNames.length) throw new Error("No active course enrollment found.");

  // You can swap this for your full synonym/harvest logic later.
  const allowedPhrases = new Set(courseNames.map((x) => x.toLowerCase()));
  return { courseNames, allowedPhrases: Array.from(allowedPhrases) };
}

function buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, resolvedTopic) {
  const sample = (allowedPhrases || []).slice(0, 60).join(" • ");
  return `[CONTEXT]
Student Email: ${studentEmail}
Enrolled Course(s): "${enrolledCourseNames}"
[ALLOWED TOPICS SAMPLE]: ${sample || "(none)"}
[RESOLVED TOPIC]: ${resolvedTopic}
[POLICY] Answer ONLY if within curriculum/sandbox. If out of scope, say so briefly and suggest 2–3 in-scope alternatives.`;
}

// ---------------- SEARCH TOOLS ----------------
const youtube = google.youtube({ version: "v3", auth: Google_Search_API_KEY });

async function search_youtube_for_videos({ query }) {
  try {
    if (!Google_Search_API_KEY) return { error: "YouTube key missing." };

    const response = await withTimeout(
      youtube.search.list({
        part: "snippet",
        q: query,
        type: "video",
        videoEmbeddable: "true",
        maxResults: 5,
      }),
      6000,
      "YouTube search timeout"
    );

    const items = (response.data.items || []).map((it) => ({
      title: it.snippet.title,
      link: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      snippet: it.snippet.description,
    }));

    return items.length
      ? { searchResults: items.slice(0, 3) }
      : { message: `No YouTube videos found for "${query}".` };
  } catch (e) {
    return { error: "Failed to search YouTube.", details: e.message };
  }
}

async function search_web_for_articles({ query }) {
  try {
    if (!Google_Search_API_KEY || !Google_Search_CX_ID) {
      return { error: "Google Search env vars missing." };
    }

    const url =
      `https://www.googleapis.com/customsearch/v1` +
      `?key=${Google_Search_API_KEY}` +
      `&cx=${Google_Search_CX_ID}` +
      `&q=${encodeURIComponent(query)}`;

    const r = await withTimeout(fetch(url), 6000, "Web search timeout");
    if (!r.ok) throw new Error(`Search API status ${r.status}`);

    const data = await r.json();
    const items = (data.items || []).map((i) => ({
      title: i.title,
      link: i.link,
      snippet: i.snippet,
    }));

    return items.length
      ? { searchResults: items.slice(0, 3) }
      : { message: `No articles found for "${query}".` };
  } catch (e) {
    return { error: "Failed to search web.", details: e.message };
  }
}

const availableTools = { search_youtube_for_videos, search_web_for_articles };

const toolDefs = [{
  functionDeclarations: [
    {
      name: "search_web_for_articles",
      description: "Search the web for high-quality articles and official docs.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "A detailed search query." },
        },
        required: ["query"],
      },
    },
    {
      name: "search_youtube_for_videos",
      description: "Search YouTube for relevant tutorial videos.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "A detailed search query." },
        },
        required: ["query"],
      },
    },
  ],
}];

// ---------------- GEMINI LIVE ----------------
// Live API WebSocket endpoint and message shapes are documented here. :contentReference[oaicite:1]{index=1}
const GEMINI_LIVE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ||
  "gemini-2.5-flash-native-audio-preview-09-2025";

function openGeminiLiveSocket({ systemInstruction, tools }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing in env.");

  const ws = new WebSocket(
    `${GEMINI_LIVE_WS}?key=${encodeURIComponent(GEMINI_API_KEY)}`
  );

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        setup: {
          model: LIVE_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO", "TEXT"],
            temperature: 0.4,
            maxOutputTokens: 512,
          },
          systemInstruction, // string is valid per Live API config. :contentReference[oaicite:2]{index=2}
          tools,
        },
      })
    );
  });

  return ws;
}

// Base instruction (keep your full one if you want)
const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized AI tutor for Pluralcode Academy.
Follow the CONTEXT policy strictly.
Do not answer out-of-scope topics.
If asked out-of-scope, say so briefly and suggest 2–3 in-scope alternatives.
`;

// ---------------- HTTP + WS BRIDGE ----------------
const server = http.createServer(app);

// Browser connects here:
const wss = new WebSocket.Server({ server, path: "/ws/voice" });

wss.on("connection", (clientWs) => {
  let geminiWs = null;
  let sessionId = crypto.randomUUID();

  const sendClient = (obj) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  };

  clientWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    // ----- START SESSION -----
    if (msg.type === "start") {
      try {
        sessionId = msg.sessionId || sessionId;

        // LMS key auth (optional; if env set, enforce)
        if (MY_LMS_API_KEY && msg.lmsKey !== MY_LMS_API_KEY) {
          sendClient({ type: "error", error: "Unauthorized client" });
          clientWs.close();
          return;
        }

        const studentEmail = normalizeEmail(msg.student_email);
        const scope = await getStudentScope(studentEmail);

        const enrolledCourseNames = scope.courseNames.join(", ");
        const allowedPhrases = scope.allowedPhrases;

        const header = buildContextHeader(
          studentEmail,
          enrolledCourseNames,
          allowedPhrases,
          "(live voice session)"
        );

        const systemInstruction =
          `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

        geminiWs = openGeminiLiveSocket({
          systemInstruction,
          tools: toolDefs,
        });

        geminiWs.on("message", async (data) => {
          let gm;
          try { gm = JSON.parse(data.toString()); }
          catch { return; }

          if (gm.setupComplete) {
            sendClient({ type: "ready", sessionId });
          }

          // stream model parts
          const parts = gm?.serverContent?.modelTurn?.parts || [];
          for (const p of parts) {
            if (p.inlineData?.mimeType?.startsWith("audio/pcm")) {
              sendClient({ type: "audio", data: p.inlineData.data });
            }
            if (p.text) {
              sendClient({ type: "text", text: p.text });
            }
          }

          // tool calling from Live API. :contentReference[oaicite:3]{index=3}
          if (gm.toolCall?.functionCalls?.length) {
            const functionResponses = [];
            for (const fc of gm.toolCall.functionCalls) {
              const fn = availableTools[fc.name];
              if (!fn) continue;

              let toolResult;
              try { toolResult = await fn(fc.args || {}); }
              catch (e) { toolResult = { error: e.message }; }

              functionResponses.push({
                id: fc.id,
                name: fc.name,
                response: {
                  name: fc.name,
                  content: [{ text: JSON.stringify(toolResult) }],
                },
              });
            }

            if (functionResponses.length) {
              geminiWs.send(
                JSON.stringify({ toolResponse: { functionResponses } })
              );
            }
          }

          if (gm?.serverContent?.turnComplete) {
            sendClient({ type: "turnComplete" });
          }
          if (gm?.serverContent?.interrupted) {
            sendClient({ type: "interrupted" });
          }
        });

        geminiWs.on("close", (code, reason) => {
          sendClient({
            type: "error",
            error: `Gemini WS closed: ${code} ${reason || ""}`,
          });
          clientWs.close();
        });

        geminiWs.on("error", (e) => {
          sendClient({ type: "error", error: e.message || "Gemini WS error" });
        });
      } catch (e) {
        sendClient({ type: "error", error: e.message });
      }
      return;
    }

    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;

    // ----- AUDIO IN: PCM16k base64 -----
    if (msg.type === "audio" && msg.data) {
      geminiWs.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: msg.data,
            },
          },
        })
      );
      return;
    }

    // ----- OPTIONAL TEXT IN -----
    if (msg.type === "text") {
      geminiWs.send(JSON.stringify({ realtimeInput: { text: msg.text || "" } }));
      return;
    }

    // ----- STOP STREAM -----
    if (msg.type === "stop") {
      geminiWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      return;
    }
  });

  clientWs.on("close", () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Praxis Voice listening on ${PORT}`);
});

// ---------------- INLINE TEST PAGE ----------------
const VOICE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Praxis Voice Test</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; max-width: 720px; margin: auto; }
    input, button { padding: 8px; margin: 4px; }
    #log { white-space: pre-wrap; background: #111; color: #0f0; padding: 10px; height: 160px; overflow: auto; }
    #transcript { white-space: pre-wrap; border: 1px solid #ccc; padding: 10px; min-height: 140px; }
  </style>
</head>
<body>
  <h2>Praxis Voice Test</h2>

  <div>
    <input id="email" placeholder="student_email" size="35" />
    <input id="lmsKey" placeholder="lmsKey (if needed)" size="25" />
    <button id="connectBtn">Connect</button>
    <button id="startBtn" disabled>Start Mic</button>
    <button id="stopBtn" disabled>Stop Mic</button>
  </div>

  <h3>Status</h3>
  <div id="log"></div>

  <h3>Transcript</h3>
  <div id="transcript"></div>

<script>
(() => {
  const logEl = document.getElementById("log");
  const transEl = document.getElementById("transcript");
  const connectBtn = document.getElementById("connectBtn");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const emailEl = document.getElementById("email");
  const lmsKeyEl = document.getElementById("lmsKey");

  let ws;
  let audioCtx;
  let micStream;
  let processor;
  let playingQueue = Promise.resolve();

  function log(s) {
    logEl.textContent += s + "\\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
  function addText(s) {
    transEl.textContent += s + "\\n";
    transEl.scrollTop = transEl.scrollHeight;
  }

  // Float32 -> Int16 PCM
  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  // Resample to 16k (very small linear resampler)
  function resampleTo16k(input, inRate) {
    if (inRate === 16000) return input;
    const ratio = inRate / 16000;
    const newLen = Math.round(input.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function base64FromInt16(int16) {
    const u8 = new Uint8Array(int16.buffer);
    let binary = "";
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    return btoa(binary);
  }

  function int16FromBase64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(u8.buffer);
  }

  async function playPCM16k(b64) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    const int16 = int16FromBase64(b64);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;

    const buffer = audioCtx.createBuffer(1, f32.length, 16000);
    buffer.getChannelData(0).set(f32);

    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);

    // queue to avoid overlap pops
    playingQueue = playingQueue.then(() => new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    }));
  }

  connectBtn.onclick = () => {
    const wsUrl = location.origin.replace("https://","wss://").replace("http://","ws://") + "/ws/voice";
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log("WS open: " + wsUrl);
      ws.send(JSON.stringify({
        type: "start",
        student_email: emailEl.value.trim(),
        lmsKey: lmsKeyEl.value.trim() || undefined
      }));
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "ready") {
        log("Gemini ready. sessionId=" + msg.sessionId);
        startBtn.disabled = false;
        stopBtn.disabled = false;
      }

      if (msg.type === "text") addText("AI: " + msg.text);

      if (msg.type === "audio") {
        await playPCM16k(msg.data);
      }

      if (msg.type === "turnComplete") {
        log("Turn complete.");
      }

      if (msg.type === "error") {
        log("ERROR: " + msg.error);
      }
    };

    ws.onerror = (e) => log("WS error");
    ws.onclose = () => log("WS closed");
  };

  startBtn.onclick = async () => {
    if (!ws || ws.readyState !== 1) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleTo16k(input, audioCtx.sampleRate);
      const pcm16 = floatTo16BitPCM(resampled);
      const b64 = base64FromInt16(pcm16);

      ws.send(JSON.stringify({ type: "audio", data: b64 }));
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
    log("Mic streaming...");
  };

  stopBtn.onclick = () => {
    if (processor) processor.disconnect();
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" }));
    log("Mic stopped.");
  };
})();
</script>
</body>
</html>`;
