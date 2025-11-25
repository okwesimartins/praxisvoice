/**
 * server.js — Praxis Voice Backend (Cloud Run)
 * - Express health + serves static frontend
 * - WS /ws: browser audio <-> Gemini Live API
 * - Enforces LMS key + student course scope
 * - Supports tool calling (Google Web + YouTube search)
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");
const { google } = require("googleapis");

// ---- fetch polyfill (Node < 18) ----
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => fetchFn(...args);

// Crash logging so Cloud Run shows real reasons
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED_REJECTION", e));

// -----------------------------------------------------------------------------
// EXPRESS APP (health check only - frontend hosted separately)
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ok", service: "Praxis Voice API" }));
app.get("/health", (req, res) => res.json({ status: "healthy" }));

app.get("/voice", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "voice-app.html"));
});
// -----------------------------------------------------------------------------
// Pluralcode scope enforcement
// -----------------------------------------------------------------------------
const PLURALCODE_API_BASE =
  process.env.PLURALCODE_API_URL || "https://backend.pluralcode.institute";

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

const addSynonyms = (phrase, bag) => {
  const raw = String(phrase || "");
  const display = raw.trim();
  const p = display.toLowerCase();
  if (!display) return bag;
  bag.add(display);

  if (/javascript/.test(p)) { bag.add("javascript"); bag.add("js"); }

  if (/python/.test(p) || /data\s*analytics?/.test(p)) {
    [
      "python","numpy","pandas","matplotlib","seaborn","scikit-learn",
      "jupyter","anaconda","etl","data wrangling",
    ].forEach((x) => bag.add(x));
  }
  if (/\bsql\b/.test(p)) bag.add("sql");
  if (/excel/.test(p)) bag.add("excel");
  if (/power\s*bi|powerbi|pbi/.test(p)) {
    bag.add("power bi"); bag.add("pbi"); bag.add("powerbi");
  }
  if (/machine\s*learning/.test(p)) { bag.add("ml"); bag.add("machine learning"); }
  if (/web\s*scraping/.test(p)) bag.add("web scraping");
  if (/dax/.test(p)) bag.add("dax");

  if (/\bscrum\b|agile/.test(p)) {
    "scrum,agile,scrum events,scrum ceremonies,agile ceremonies,sprint planning,daily scrum,daily standup,sprint review,sprint retrospective,backlog refinement,product backlog refinement"
      .split(",").forEach((x) => bag.add(x));
  }
  if (/kanban/.test(p)) bag.add("kanban");

  return bag;
};

const TOPIC_STRING_KEYS = new Set([
  "coursename","course","course_name","name","title","topic","topic_name","label",
  "module","module_name","lesson","lesson_name","chapter","section","unit",
]);

function harvestCourseStrings(node, bag) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const it of node) harvestCourseStrings(it, bag);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const key = String(k).toLowerCase();
      if (typeof v === "string") {
        if (TOPIC_STRING_KEYS.has(key)) {
          const s = v.trim();
          if (s && !/^https?:\/\//i.test(s) && s.length <= 200) addSynonyms(s, bag);
        }
      } else if (Array.isArray(v)) {
        for (const child of v) harvestCourseStrings(child, bag);
      } else if (typeof v === "object" && v) {
        harvestCourseStrings(v, bag);
      }
    }
  }
}

const buildAllowedFromPayload = (data) => {
  const phrases = new Set();
  const courseNames = [];

  const enrolled = Array.isArray(data.enrolled_courses) ? data.enrolled_courses : [];
  for (const c of enrolled) {
    const courseName = (c.coursename || c.course_name || c.name || c.title || "").trim();
    if (courseName) { courseNames.push(courseName); addSynonyms(courseName, phrases); }
    if (c.course_topics) harvestCourseStrings(c.course_topics, phrases);
    else harvestCourseStrings(c, phrases);
  }

  const sandbox = Array.isArray(data.sandbox) ? data.sandbox : [];
  for (const s of sandbox) harvestCourseStrings(s, phrases);

  return { courseNames, allowedPhrases: Array.from(phrases) };
};

const withTimeout = async (promise, ms, msg = "Timed out") => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
  return Promise.race([promise, timeout]);
};

async function getStudentScope(email) {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Student email is missing.");

  const url = `${PLURALCODE_API_BASE}/student/praxis_get_student_courses?email=${encodeURIComponent(clean)}`;
  const response = await withTimeout(fetch(url), 8000, "Pluralcode API timeout");
  if (!response.ok) throw new Error(`Pluralcode API failed with status ${response.status}`);

  const data = await response.json();
  const scope = buildAllowedFromPayload(data);
  if (!scope.courseNames.length) throw new Error("No active course enrollment found.");
  return scope;
}

const summarizeAllowed = (arr, n = 80) => {
  if (!Array.isArray(arr) || !arr.length) return "(none)";
  const head = arr.slice(0, n).join(" • ");
  return head + (arr.length > n ? ` • (+${arr.length - n} more)` : "");
};

function buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases) {
  const sample = summarizeAllowed(allowedPhrases, 80);
  return `[CONTEXT]
Student Email: ${studentEmail}
Enrolled Course(s): "${enrolledCourseNames}"
[ALLOWED TOPICS SAMPLE] (truncated): ${sample}
[POLICY] Answer ONLY if the topic is within the student's curriculum/sandbox. If out of scope, briefly say it's outside their program and offer 2–3 in-scope alternatives.`;
}

// -----------------------------------------------------------------------------
// Google search tools
// -----------------------------------------------------------------------------
const Google_Search_API_KEY = process.env.Google_Search_API_KEY;
const Google_Search_CX_ID = process.env.Google_Search_CX_ID;

const youtube = google.youtube({
  version: "v3",
  auth: Google_Search_API_KEY,
});

const isLikelyGoodUrl = (url) => {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/webcache\.googleusercontent\.com|translate\.googleusercontent\.com|accounts\.google\.com/i.test(url))
    return false;
  return true;
};

const validateUrl = async (url) => {
  if (url.includes("pluralcode.academy") || url.includes("drive.google.com")) return true;
  if (!isLikelyGoodUrl(url)) return false;
  try {
    const res = await withTimeout(fetch(url, { method: "HEAD" }), 3500);
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
  } catch (_) {}
  return false;
};

const cleanAndValidateResults = async (items, max = 3) => {
  const pruned = [];
  for (const item of items || []) {
    if (!item?.link) continue;
    if (!isLikelyGoodUrl(item.link)) continue;
    if (await validateUrl(item.link)) pruned.push(item);
    if (pruned.length >= max) break;
  }
  return pruned;
};

async function search_youtube_for_videos({ query }) {
  const response = await withTimeout(
    youtube.search.list({
      part: "snippet",
      q: query,
      type: "video",
      videoEmbeddable: "true",
      maxResults: 6,
    }),
    6000,
    "YouTube search timeout"
  );

  const items = (response.data.items || []).map((it) => ({
    title: it.snippet.title,
    link: `https://www.youtube.com/watch?v=${it.id.videoId}`,
    snippet: it.snippet.description,
  }));

  const valid = await cleanAndValidateResults(items, 3);
  return valid.length
    ? { searchResults: valid }
    : { message: `No YouTube videos found for "${query}".` };
}

async function search_web_for_articles({ query }) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${Google_Search_API_KEY}&cx=${Google_Search_CX_ID}&q=${encodeURIComponent(query)}`;
  const res = await withTimeout(fetch(url), 6000, "Web search timeout");
  if (!res.ok) throw new Error(`Google Search API responded with status ${res.status}`);

  const data = await res.json();
  const items = (data.items || []).map((i) => ({
    title: i.title,
    link: i.link,
    snippet: i.snippet,
  }));

  const valid = await cleanAndValidateResults(items, 3);
  return valid.length
    ? { searchResults: valid }
    : { message: `No articles found for "${query}".` };
}

const availableTools = { search_youtube_for_videos, search_web_for_articles };

const toolDefs = [{
  functionDeclarations: [
    {
      name: "search_web_for_articles",
      description: "Search the web for high-quality articles, blog posts, and official documentation.",
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

// -----------------------------------------------------------------------------
// Gemini Live API bridge
// -----------------------------------------------------------------------------
const GEMINI_LIVE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_MODEL_ENV =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-09-2025";
const LIVE_MODEL =
  LIVE_MODEL_ENV.startsWith("models/") ? LIVE_MODEL_ENV : `models/${LIVE_MODEL_ENV}`;

const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized AI tutor for Pluralcode Academy.

PLURALCODE KNOWLEDGE BASE (MANDATORY USAGE)
- Official brand/site info: https://pluralcode.academy.
- Course structure/modules/details must use official Pluralcode curriculum PDFs.
CORE RULES
1) Stay strictly within the student's enrolled course scope; sandbox topics are always allowed.
2) If out of scope, say so briefly and offer 2–3 in-scope alternatives.
3) Prefer authoritative sources when searching the web.
Do NOT invent links.
`;

function openGeminiLiveSocket({ systemInstruction, tools }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing in env.");

  const ws = new WebSocket(`${GEMINI_LIVE_WS}?key=${encodeURIComponent(apiKey)}`);

  ws.on("open", () => {
    const setupPayload = {
      setup: {
        model: LIVE_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.4,
          maxOutputTokens: 512,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Puck" // Lighter, more energetic voice (was Aoede)
              }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        }
      }
    };

    if (tools && Array.isArray(tools) && tools.length > 0 && tools[0].functionDeclarations?.length > 0) {
      setupPayload.setup.tools = tools;
    }

    console.log("📤 Sending Gemini setup:", JSON.stringify(setupPayload, null, 2));
    ws.send(JSON.stringify(setupPayload));
  });

  return ws;
}

// -----------------------------------------------------------------------------
// HTTP + WebSocket server
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

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
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "start") {
      try {
        sessionId = msg.sessionId || sessionId;

        if (msg.lmsKey && msg.lmsKey !== process.env.MY_LMS_API_KEY) {
          sendClient({ type: "error", error: "Unauthorized client" });
          clientWs.close();
          return;
        }

        const studentEmail = normalizeEmail(msg.student_email);
        const scope = await getStudentScope(studentEmail);
        const enrolledCourseNames = scope.courseNames.join(", ");
        const allowedPhrases = scope.allowedPhrases;

        const header = buildContextHeader(
          studentEmail, enrolledCourseNames, allowedPhrases
        );

        const sys = `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

        geminiWs = openGeminiLiveSocket({
          systemInstruction: sys,
          tools: toolDefs,
        });

        geminiWs.on("message", async (data) => {
          let gm;
          try { gm = JSON.parse(data.toString()); } catch { return; }

          if (gm.setupComplete) {
            console.log("✅ Gemini setup complete");
            sendClient({ type: "ready", sessionId });
          }

          const parts = gm?.serverContent?.modelTurn?.parts || [];
          for (const p of parts) {
            if (p.inlineData?.mimeType?.startsWith("audio/pcm")) {
              sendClient({ type: "audio", data: p.inlineData.data });
            }
            if (p.text) {
              sendClient({ type: "text", text: p.text });
            }
          }

          if (gm.toolCall?.functionCalls?.length) {
            console.log("🔧 Tool calls:", gm.toolCall.functionCalls.map(fc => fc.name));
            const functionResponses = [];
            for (const fc of gm.toolCall.functionCalls) {
              const fn = availableTools[fc.name];
              if (!fn) continue;
              const toolResult = await fn(fc.args || {});
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
              geminiWs.send(JSON.stringify({ toolResponse: { functionResponses } }));
            }
          }

          if (gm?.serverContent?.turnComplete) {
            sendClient({ type: "turnComplete" });
          }
        });

        geminiWs.on("close", (code, reason) => {
          console.error("❌ Gemini WS closed:", code, reason?.toString() || "");
          sendClient({
            type: "error",
            error: `Gemini WS closed: ${code} ${reason || ""}`,
          });
          clientWs.close();
        });

        geminiWs.on("error", (e) => {
          console.error("❌ Gemini WS error:", e);
          sendClient({ type: "error", error: e.message || "Gemini WS error" });
        });

      } catch (e) {
        console.error("❌ Start error:", e);
        sendClient({ type: "error", error: e.message });
      }
      return;
    }

    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;

    if (msg.type === "audio") {
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: msg.data,
          },
        },
      }));
      return;
    }

    if (msg.type === "text") {
      geminiWs.send(JSON.stringify({
        realtimeInput: { text: msg.text || "" },
      }));
      return;
    }

    if (msg.type === "stop") {
      geminiWs.send(JSON.stringify({
        realtimeInput: { audioStreamEnd: true },
      }));
      return;
    }
  });

  clientWs.on("close", () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Praxis Voice listening on ${PORT}, model=${LIVE_MODEL}`)
);
