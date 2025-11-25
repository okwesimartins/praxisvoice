/**
 * server.js — Praxis Voice Backend (Cloud Run, text-only Gemini)
 * - Express health + serves static frontend from /public
 * - WS /ws: browser text <-> Gemini text
 * - Browser handles STT + TTS
 * - Enforces LMS key + student course scope
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
process.on("uncaughtException", (e) =>
  console.error("UNCAUGHT_EXCEPTION", e)
);
process.on("unhandledRejection", (e) =>
  console.error("UNHANDLED_REJECTION", e)
);

// -----------------------------------------------------------------------------
// EXPRESS APP (health + static frontend)
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) =>
  res.json({ status: "ok", service: "Praxis Voice API (text-only)" })
);
app.get("/health", (req, res) => res.json({ status: "healthy" }));

// Serve /public (voice-app.html, voice-app.js, css, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.get("/voice", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "voice-app.html"));
});

// -----------------------------------------------------------------------------
// Pluralcode scope enforcement (same as before)
// -----------------------------------------------------------------------------
const PLURALCODE_API_BASE =
  process.env.PLURALCODE_API_URL || "https://backend.pluralcode.institute";

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

// Synonyms (expanded)
const addSynonyms = (phrase, bag) => {
  const raw = String(phrase || "");
  const display = raw.trim();
  const p = display.toLowerCase();
  if (!display) return bag;
  bag.add(display);

  if (/javascript/.test(p)) {
    bag.add("javascript");
    bag.add("js");
  }

  if (/python/.test(p) || /data\s*analytics?/.test(p)) {
    [
      "python",
      "numpy",
      "pandas",
      "matplotlib",
      "seaborn",
      "scikit-learn",
      "jupyter",
      "anaconda",
      "etl",
      "data wrangling",
    ].forEach((x) => bag.add(x));
  }
  if (/\bsql\b/.test(p)) bag.add("sql");
  if (/excel/.test(p)) bag.add("excel");
  if (/power\s*bi|powerbi|pbi/.test(p)) {
    bag.add("power bi");
    bag.add("pbi");
    bag.add("powerbi");
  }
  if (/machine\s*learning/.test(p)) {
    bag.add("ml");
    bag.add("machine learning");
  }
  if (/web\s*scraping/.test(p)) bag.add("web scraping");
  if (/dax/.test(p)) bag.add("dax");

  if (/\bscrum\b|agile/.test(p)) {
    "scrum,agile,scrum events,scrum ceremonies,agile ceremonies,sprint planning,daily scrum,daily standup,sprint review,sprint retrospective,backlog refinement,product backlog refinement"
      .split(",")
      .forEach((x) => bag.add(x));
  }
  if (/kanban/.test(p)) bag.add("kanban");

  return bag;
};

const TOPIC_STRING_KEYS = new Set([
  "coursename",
  "course",
  "course_name",
  "name",
  "title",
  "topic",
  "topic_name",
  "label",
  "module",
  "module_name",
  "lesson",
  "lesson_name",
  "chapter",
  "section",
  "unit",
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
          if (s && !/^https?:\/\//i.test(s) && s.length <= 200)
            addSynonyms(s, bag);
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

  const enrolled = Array.isArray(data.enrolled_courses)
    ? data.enrolled_courses
    : [];
  for (const c of enrolled) {
    const courseName = (
      c.coursename ||
      c.course_name ||
      c.name ||
      c.title ||
      ""
    ).trim();
    if (courseName) {
      courseNames.push(courseName);
      addSynonyms(courseName, phrases);
    }
    if (c.course_topics) harvestCourseStrings(c.course_topics, phrases);
    else harvestCourseStrings(c, phrases);
  }

  const sandbox = Array.isArray(data.sandbox) ? data.sandbox : [];
  for (const s of sandbox) harvestCourseStrings(s, phrases);

  return { courseNames, allowedPhrases: Array.from(phrases) };
};

const withTimeout = async (promise, ms, msg = "Timed out") => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(msg)), ms)
  );
  return Promise.race([promise, timeout]);
};

async function getStudentScope(email) {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Student email is missing.");

  const url = `${PLURALCODE_API_BASE}/student/praxis_get_student_courses?email=${encodeURIComponent(
    clean
  )}`;
  const response = await withTimeout(fetch(url), 8000, "Pluralcode API timeout");
  if (!response.ok)
    throw new Error(`Pluralcode API failed with status ${response.status}`);

  const data = await response.json();
  const scope = buildAllowedFromPayload(data);
  if (!scope.courseNames.length)
    throw new Error("No active course enrollment found.");
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
// (Optional) Google search utilities (not wired into Gemini in this version)
// -----------------------------------------------------------------------------
const Google_Search_API_KEY = process.env.Google_Search_API_KEY;
const Google_Search_CX_ID = process.env.Google_Search_CX_ID;

const youtube = google.youtube({
  version: "v3",
  auth: Google_Search_API_KEY,
});

const isLikelyGoodUrl = (url) => {
  if (!/^https?:\/\//i.test(url)) return false;
  if (
    /webcache\.googleusercontent\.com|translate\.googleusercontent\.com|accounts\.google\.com/i.test(
      url
    )
  )
    return false;
  return true;
};

const validateUrl = async (url) => {
  if (url.includes("pluralcode.academy") || url.includes("drive.google.com"))
    return true;
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
  const url = `https://www.googleapis.com/customsearch/v1?key=${Google_Search_API_KEY}&cx=${Google_Search_CX_ID}&q=${encodeURIComponent(
    query
  )}`;
  const res = await withTimeout(fetch(url), 6000, "Web search timeout");
  if (!res.ok)
    throw new Error(`Google Search API responded with status ${res.status}`);

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

// -----------------------------------------------------------------------------
// Gemini text model (HTTP, not Live)
// -----------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY is not set in env.");
}

// pick any regular text model you like
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
  GEMINI_API_KEY || ""
)}`;

const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized AI tutor for Pluralcode Academy.

PLURALCODE KNOWLEDGE BASE (MANDATORY USAGE)
- Official brand/site info: https://pluralcode.academy.
- Course structure/modules/details must use official Pluralcode curriculum PDFs.

CORE RULES
1) Stay strictly within the student's enrolled course scope; sandbox topics are always allowed.
2) If out of scope, say so briefly and offer 2–3 in-scope alternatives.
3) Prefer authoritative sources when describing tools or technologies.
4) Do NOT invent URLs or login links.
`;

// Call Gemini with conversation history
async function callGemini({ systemInstruction, history }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing");

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: history,
  };

  const res = await withTimeout(
    fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    20000,
    "Gemini API timeout"
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gemini API error: ${res.status} ${res.statusText} ${text}`
    );
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text =
    parts
      .map((p) => p.text || "")
      .join("")
      .trim() || "I’m not sure how to respond to that.";

  return text;
}

// -----------------------------------------------------------------------------
// HTTP + WebSocket server
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (clientWs) => {
  // Per-connection session
  const session = {
    id: crypto.randomUUID(),
    systemInstruction: null,
    history: [], // [{role:"user"|"model", parts:[{text}]}]
    busy: false,
  };

  const sendClient = (obj) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  };

  clientWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad JSON from client:", e);
      return;
    }

    // --- Initial setup from frontend ---
    if (msg.type === "start") {
      try {
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
          studentEmail,
          enrolledCourseNames,
          allowedPhrases
        );

        session.systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;
        session.history = [];

        sendClient({
          type: "ready",
          sessionId: session.id,
        });
      } catch (e) {
        console.error("Start error:", e);
        sendClient({ type: "error", error: e.message });
      }
      return;
    }

    // Ignore anything before "start"
    if (!session.systemInstruction) {
      sendClient({
        type: "error",
        error: "Session not initialized. Send a 'start' message first.",
      });
      return;
    }

    // --- User text from browser (via STT) ---
    if (msg.type === "userText") {
      const text = String(msg.text || "").trim();
      if (!text) return;

      if (session.busy) {
        sendClient({
          type: "error",
          error: "Praxis is still responding. Wait for the current answer to finish.",
        });
        return;
      }

      session.busy = true;

      // Keep a limited history size to avoid huge prompts
      const MAX_TURNS = 12; // user+model pairs
      if (session.history.length > MAX_TURNS * 2) {
        session.history = session.history.slice(-MAX_TURNS * 2);
      }

      // Record user message
      session.history.push({
        role: "user",
        parts: [{ text }],
      });

      sendClient({ type: "aiThinking" });

      try {
        const replyText = await callGemini({
          systemInstruction: session.systemInstruction,
          history: session.history,
        });

        // Record model reply
        session.history.push({
          role: "model",
          parts: [{ text: replyText }],
        });

        sendClient({ type: "aiText", text: replyText });
        sendClient({ type: "turnComplete" });
      } catch (e) {
        console.error("Gemini call error:", e);
        sendClient({ type: "error", error: e.message });
      } finally {
        session.busy = false;
      }

      return;
    }

    // Optional: stop message from client
    if (msg.type === "stop") {
      // For text-only, nothing special to send to Gemini.
      sendClient({ type: "info", message: "Session stop requested" });
      clientWs.close();
      return;
    }
  });

  clientWs.on("close", () => {
    // Cleanup if needed
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Praxis Voice (text-only) listening on ${PORT}, model=${GEMINI_MODEL}`)
);
