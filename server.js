/**
 * server.js — Praxis Voice Backend (HTTP, no WebSockets)
 * - Express health + serves static frontend (public/)
 * - POST /api/chat: browser text <-> Gemini text API
 * - Pluralcode student scope enforcement (same as before)
 */

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
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
process.on("unhandledRejection", (e) =>
  console.error("UNHANDLED_REJECTION", e)
);

// -----------------------------------------------------------------------------
// EXPRESS APP (health + static frontend)
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Health endpoints
app.get("/", (req, res) =>
  res.json({ status: "ok", service: "Praxis Voice API (HTTP)" })
);
app.get("/health", (req, res) => res.json({ status: "healthy" }));

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));
app.get("/voice", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "voice-app.html"));
});

// -----------------------------------------------------------------------------
// Pluralcode scope enforcement (unchanged)
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
[POLICY] Answer ONLY if the topic is within the student's curriculum/sandbox. If out of scope, briefly say it's outside their program and offer 2–3 in-scope alternatives.

When giving YouTube videos or articles, include full clickable links in the text response. Avoid reading out full URLs; just describe them briefly in natural language.`;
}

// -----------------------------------------------------------------------------
// (Optional) Google search tools - left here if you want later function-calling
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
// Gemini text API (HTTP)
// -----------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY not set in environment!");
}

const RAW_MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-pro";
// Ensure format models/...
const GEMINI_MODEL = RAW_MODEL.startsWith("models/")
  ? RAW_MODEL
  : `models/${RAW_MODEL}`;

const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized AI tutor for Pluralcode Academy.

PLURALCODE KNOWLEDGE BASE (MANDATORY USAGE)
- Official brand/site info: https://pluralcode.academy.
- Course structure/modules/details must use official Pluralcode curriculum PDFs.
CORE RULES
1) Stay strictly within the student's enrolled course scope; sandbox topics are always allowed.
2) If out of scope, say so briefly and offer 2–3 in-scope alternatives.
3) Prefer authoritative sources when suggesting external resources.
4) Include links in text when appropriate (YouTube, documentation, articles). Do not read out full URLs; summarize verbally instead.
`;

/**
 * Call Gemini text model with system instruction + contents array.
 * contents: [{ role: "user"|"model", parts:[{ text }] }, ...]
 */
async function callGeminiChat({ systemInstruction, contents }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Gemini error response:", errText);
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json();
  const parts =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean) ||
    [];
  const text = parts.join(" ").trim() || "(no response text)";
  return text;
}

// -----------------------------------------------------------------------------
// POST /api/chat  (front-end sends student_email, message, history)
// -----------------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { student_email, lmsKey, message, history } = req.body || {};

    if (!student_email || !message) {
      return res.status(400).json({
        error: "student_email and message are required.",
      });
    }

    // Optional LMS key gate
    if (lmsKey && lmsKey !== process.env.MY_LMS_API_KEY) {
      return res.status(403).json({ error: "Invalid LMS key." });
    }

    // Enforce scope
    const studentEmail = normalizeEmail(student_email);
    const scope = await getStudentScope(studentEmail);
    const enrolledCourseNames = scope.courseNames.join(", ");
    const allowedPhrases = scope.allowedPhrases;

    const header = buildContextHeader(
      studentEmail,
      enrolledCourseNames,
      allowedPhrases
    );
    const systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

    // Build conversation contents
    const contents = [];

    // History from the client: [{ role: "user"|"assistant", text }]
    if (Array.isArray(history)) {
      for (const h of history) {
        if (!h || !h.text) continue;
        let role = "user";
        if (h.role === "assistant" || h.role === "model") role = "model";
        contents.push({
          role,
          parts: [{ text: h.text }],
        });
      }
    }

    // Current user message
    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    const aiText = await callGeminiChat({
      systemInstruction,
      contents,
    });

    return res.json({ text: aiText });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Praxis Voice HTTP listening on ${PORT}, model=${GEMINI_MODEL}`)
);
