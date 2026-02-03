/**
 * server.js — Praxis Voice Backend (Gemini + Google TTS + WebSocket)
 *
 * ✅ DROP-IN FIX (Jan/Feb 2026 safe):
 * - Removes hard-coded GEMINI_MODEL variable usage everywhere
 * - Uses the current official Node SDK: @google/genai (dynamic import for CJS)
 * - Auto-probes working models and survives “404 model not found”
 * - Never crashes the voice flow on “empty response” — returns a safe fallback sentence
 *
 * IMPORTANT:
 *   npm uninstall @google/generative-ai
 *   npm install @google/genai
 *
 * ENV:
 *   GEMINI_API_KEY=...
 *   (optional) GEMINI_MODEL=gemini-2.5-flash   // recommended for voice latency
 *   (optional) GEMINI_API_VERSION=v1
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
const textToSpeech = require("@google-cloud/text-to-speech");
const { getEventsForStudent } = require("./googleCalendar");

// ---- fetch polyfill (Node < 18) ----
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => fetchFn(...args);

// Google TTS client (uses default credentials on Cloud Run)
const ttsClient = new textToSpeech.TextToSpeechClient();

// Crash logging so Cloud Run shows real reasons
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED_REJECTION", e));

// -----------------------------------------------------------------------------
// EXPRESS APP (health + static frontend)
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) =>
  res.json({ status: "ok", service: "Praxis Voice (Gemini+TTS+WS)" })
);
app.get("/health", (req, res) => res.json({ status: "healthy" }));

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));
app.get("/voice", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "voice-app.html"));
});

// -----------------------------------------------------------------------------
// Calendar helpers + endpoint
// -----------------------------------------------------------------------------
function extractMeetingLink(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;

  const conf = ev.conferenceData;
  if (!conf) return null;

  if (Array.isArray(conf.entryPoints)) {
    const videoEntry = conf.entryPoints.find(
      (ep) => ep.entryPointType === "video" && ep.uri
    );
    if (videoEntry) return videoEntry.uri;
  }
  return null;
}

app.get("/calendar-events", async (req, res) => {
  try {
    const { email, calendarId } = req.query;

    if (req.headers["x-api-key"] !== process.env.MY_LMS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!email || !calendarId) {
      return res
        .status(400)
        .json({ error: "Missing required query params: email, calendarId" });
    }

    const studentEmail = normalizeEmail(email);

    const events = await getEventsForStudent(calendarId, studentEmail);

    const formatted = events.map((ev) => ({
      id: ev.id,
      summary: ev.summary || "",
      description: ev.description || "",
      start: ev.start,
      end: ev.end,
      htmlLink: ev.htmlLink || "",
      location: ev.location || "",
      meetingLink: extractMeetingLink(ev) || "",
      isAllDay: !!ev.start?.date && !ev.start?.dateTime,
      isRecurring: !!(ev.recurringEventId || ev.recurrence),
      recurringEventId: ev.recurringEventId || null,
    }));

    return res.json({ events: formatted });
  } catch (err) {
    console.error("/calendar-events error:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch events", details: err.message });
  }
});

// -----------------------------------------------------------------------------
// Pluralcode scope enforcement (matching your Slack bot logic)
// -----------------------------------------------------------------------------
const PLURALCODE_API_BASE =
  process.env.PLURALCODE_API_URL || "https://backend.pluralcode.institute";

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

const withTimeout = async (promise, ms, msg = "Timed out") => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(msg)), ms)
  );
  return Promise.race([promise, timeout]);
};

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
      "excel",
      "power bi",
      "sql",
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

const TOPIC_ARRAY_KEYS = new Set([
  "course_topics",
  "topics",
  "sub_topic",
  "sub_topics",
  "children",
  "modules",
  "lessons",
  "chapters",
  "sections",
  "units",
  "items",
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
          if (s && !/^https?:\/\//i.test(s) && s.length <= 200) {
            addSynonyms(s, bag);
          }
        }
      } else if (Array.isArray(v) && TOPIC_ARRAY_KEYS.has(key)) {
        for (const child of v) harvestCourseStrings(child, bag);
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

  try {
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
  } catch (_) {}

  return { courseNames, allowedPhrases: Array.from(phrases) };
};

async function getStudentScope(email) {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Student email is missing.");

  const url = `${PLURALCODE_API_BASE}/student/praxis_get_student_courses?email=${encodeURIComponent(
    clean
  )}`;

  try {
    const response = await withTimeout(fetch(url), 8000, "Pluralcode API timeout");
    if (!response.ok)
      throw new Error(`Pluralcode API failed with status ${response.status}`);
    const data = await response.json();
    const scope = buildAllowedFromPayload(data);
    if (!scope.courseNames.length)
      throw new Error("No active course enrollment found.");
    return scope;
  } catch (error) {
    throw new Error("Could not verify student enrollment.");
  }
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
[ALLOWED TOPICS EXAMPLES] (not exhaustive, you may generalize): ${sample}

[POLICY]
- You are Praxis, a calm, friendly MALE online tutor for Pluralcode Academy.
- Focus on the student's enrolled course(s) and closely related tools and topics.
- Standard tools for those courses (for example: Excel, Power BI, SQL, Python, NumPy, pandas, Jupyter, ETL, Scrum, Kanban, etc.) are considered IN SCOPE even if the exact word does not literally appear in the raw curriculum data.
- Only say a topic is "outside their curriculum" if it is clearly unrelated to all enrolled courses.
- If something is ambiguous but plausibly part of their course (like Excel for Data Analytics), treat it as in-scope and answer.
- When you recommend external resources, include full URLs in the text so the UI can show previews. In voice, do NOT spell out the URL; just refer to it naturally.`;
}

function isQuizRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes("quiz")) return true;
  if (t.includes("test me")) return true;
  if (t.includes("practice questions")) return true;
  if (t.includes("practice test")) return true;
  if (t.includes("mcq")) return true;
  if (t.includes("multiple choice") && t.includes("question")) return true;
  return false;
}

// -----------------------------------------------------------------------------
// (Optional) Google search helpers — available if you later want tools
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
    const res = await withTimeout(fetch(url), 3500, "URL HEAD timeout");
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
  } catch (_) {
    try {
      const res2 = await withTimeout(
        fetch(url, { method: "GET", headers: { Range: "bytes=0-1024" } }),
        4500,
        "URL GET timeout"
      );
      if (res2.ok || (res2.status >= 300 && res2.status < 400)) return true;
    } catch (__) {}
  }
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
  if (!Google_Search_API_KEY) {
    return { message: "YouTube search is not configured." };
  }
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
  if (!Google_Search_API_KEY || !Google_Search_CX_ID) {
    return { message: "Web search is not configured." };
  }
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
// Gemini — DROP-IN FIX (NO GEMINI_MODEL GLOBAL USED ANYWHERE)
// -----------------------------------------------------------------------------
let _aiClientPromise = null;
let _activeModel = null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1";

const ENV_MODEL_RAW = (process.env.GEMINI_MODEL || "").trim();
const MODEL_FALLBACKS = [
  ...(ENV_MODEL_RAW ? [ENV_MODEL_RAW] : []),
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash-preview", // last resort
];

function normalizeModelName(m) {
  return String(m || "").trim().replace(/^models\//, "");
}

function getCurrentModelLabel() {
  return _activeModel ? _activeModel : "(resolving)";
}

async function getGeminiClient() {
  if (_aiClientPromise) return _aiClientPromise;

  _aiClientPromise = (async () => {
    if (!GEMINI_API_KEY || !String(GEMINI_API_KEY).trim()) {
      throw new Error("GEMINI_API_KEY is missing or empty.");
    }

    // ESM-first package, but this file is CommonJS: dynamic import works.
    const mod = await import("@google/genai");
    const GoogleGenAI = mod.GoogleGenAI;

    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: { apiVersion: GEMINI_API_VERSION },
    });

    console.log(`✅ Gemini client ready (apiVersion=${GEMINI_API_VERSION})`);
    return ai;
  })();

  return _aiClientPromise;
}

async function modelWorks(ai, model) {
  const modelId = normalizeModelName(model);
  try {
    await ai.models.get({ model: modelId });

    const probe = await ai.models.generateContent({
      model: modelId,
      contents: "ping",
      config: { maxOutputTokens: 4, temperature: 0, candidateCount: 1 },
    });

    const t = probe?.text ? String(probe.text).trim() : "";
    return t.length > 0;
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`⚠️ Model probe failed for "${modelId}": ${msg}`);
    return false;
  }
}

async function resolveActiveModel() {
  if (_activeModel) return _activeModel;

  const ai = await getGeminiClient();
  for (const candidate of MODEL_FALLBACKS) {
    const id = normalizeModelName(candidate);
    if (await modelWorks(ai, id)) {
      _activeModel = id;
      console.log(`📌 Using Gemini model: ${_activeModel}`);
      return _activeModel;
    }
  }

  throw new Error(
    `No working Gemini model found. Tried: ${MODEL_FALLBACKS.map(normalizeModelName).join(
      ", "
    )}`
  );
}

function clampContents(contents, maxItems = 24) {
  if (!Array.isArray(contents)) return contents;
  if (contents.length <= maxItems) return contents;
  return contents.slice(contents.length - maxItems);
}

function extractTextOrFallback(resp) {
  const t = resp?.text ? String(resp.text).trim() : "";
  if (t) return { text: t, blocked: false };

  const parts = resp?.candidates?.[0]?.content?.parts || [];
  const joined = parts.map((p) => p?.text || "").join("").trim();
  if (joined) return { text: joined, blocked: false };

  const finishReason = resp?.candidates?.[0]?.finishReason || null;
  const blockReason = resp?.promptFeedback?.blockReason || null;

  return {
    text:
      "I couldn’t generate a response for that. Please rephrase your question in a simpler way.",
    blocked: true,
    meta: { finishReason, blockReason },
  };
}

/**
 * Call Gemini via @google/genai generateContent
 * contents: [{ role: "user"|"model", parts:[{ text }] }, ...]
 */
async function callGeminiChat({ systemInstruction, contents, maxTokens }) {
  const ai = await getGeminiClient();
  const model = await resolveActiveModel();
  const safeContents = clampContents(contents, 24);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: safeContents,
      config: {
        systemInstruction: systemInstruction || "",
        temperature: 0.4,
        candidateCount: 1,
        maxOutputTokens: maxTokens || 512,
      },
    });

    const extracted = extractTextOrFallback(resp);
    if (extracted.blocked) {
      console.warn("[Gemini] Empty/blocked response meta:", extracted.meta || {});
    }
    return extracted.text;
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("Gemini generateContent failed:", msg);

    // If model got retired / 404’d mid-flight: reset and retry once.
    if (/404|not found|Model/i.test(msg)) {
      _activeModel = null;
      const retryModel = await resolveActiveModel();

      const resp2 = await ai.models.generateContent({
        model: retryModel,
        contents: safeContents,
        config: {
          systemInstruction: systemInstruction || "",
          temperature: 0.4,
          candidateCount: 1,
          maxOutputTokens: maxTokens || 512,
        },
      });

      return extractTextOrFallback(resp2).text;
    }

    throw new Error(`Gemini API error: ${msg}`);
  }
}

// Warmup (non-blocking)
resolveActiveModel().catch((e) => console.warn("Gemini warmup failed:", e.message || e));

// -----------------------------------------------------------------------------
// System instructions
// -----------------------------------------------------------------------------
const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized MALE AI tutor for Pluralcode Academy students.

ROLE & STYLE
- Teach like a patient human teacher: break explanations into steps, use simple examples, and ask brief check-in questions.
- Keep your tone friendly, calm, and professional.
- You are primarily used through VOICE, but your text answers are also shown on screen.

QUIZZES
- By default you may sometimes suggest a short quiz after explaining a topic.
- If the student explicitly asks for a quiz/test/practice questions/MCQs, you MUST generate a quiz of EXACTLY 10 multiple-choice questions.
- Every quiz question must include the correct answer so the frontend can grade it.
- When you provide a multiple-choice quiz, use this exact JSON-line format for EACH question:
  QUIZ: {"question":"...","options":["A","B","C","D"],"correctIndex":1,"explanation":"..."}
- Each question must have exactly 4 options and a correctIndex from 0 to 3.
- Make explanations short (1–2 sentences) and do not include additional JSON outside these QUIZ lines.
- Do NOT put curly braces { or } inside the question, options, or explanation text.

LINKS & RESOURCES
- When you recommend YouTube videos or articles, include full URLs in the TEXT so the UI can show previews.
- Whenever you share specific resources, also append one JSON line per resource at the END of your reply in one of these formats:
  VIDEO: {"title":"...","url":"https://...","description":"...","platform":"youtube"}
  ARTICLE: {"title":"...","url":"https://...","description":"...","source":"article"}
- Do NOT put curly braces { or } inside any of the string fields in these JSON objects.
- If the student explicitly asks for videos or articles, you MUST include at least 3 structured VIDEO or ARTICLE lines (if such resources exist).
- In voice, do NOT read out the full URL; just say something like: "I'm sharing a link in your resources panel."

SCOPE
- You must also follow an extra [CONTEXT] block that describes the student's enrolled courses and allowed topics.
- If a request is clearly unrelated to all enrolled courses, briefly say so and suggest 2–3 in-scope alternatives instead of trying to answer it.
`;

const QUIZ_MODE_INSTRUCTION = `
[QUIZ MODE OVERRIDE]
The student has explicitly requested a quiz or test in their most recent message.

For THIS reply you must:
- Focus the quiz on the student's current topic or enrolled courses.
- Generate EXACTLY 10 multiple-choice questions.
- Each question must have exactly 4 options.
- Output each question on its own line in this exact format:
  QUIZ: {"question":"...","options":["A","B","C","D"],"correctIndex":1,"explanation":"..."}
- "correctIndex" must be 0, 1, 2, or 3 and must match the correct option in the "options" array.
- Keep "question", each option, and "explanation" as short, clear English strings.
- Do NOT include any other JSON or markdown.
- You may include at most ONE short introductory sentence before the QUIZ lines.
`;

// -----------------------------------------------------------------------------
// TEST ENDPOINT - Verify Gemini API using current SDK
// -----------------------------------------------------------------------------
app.get("/test-gemini", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }

    const ai = await getGeminiClient();
    const model = await resolveActiveModel();

    const resp = await ai.models.generateContent({
      model,
      contents: "Say hello in one word",
      config: { maxOutputTokens: 16, temperature: 0, candidateCount: 1 },
    });

    const extracted = extractTextOrFallback(resp);

    res.json({
      success: true,
      model,
      apiVersion: GEMINI_API_VERSION,
      response: extracted.text,
      blocked: !!extracted.blocked,
      meta: extracted.meta || null,
      note: "Using @google/genai",
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      model: getCurrentModelLabel(),
      apiVersion: GEMINI_API_VERSION,
      note: "Make sure @google/genai is installed: npm install @google/genai",
    });
  }
});

// -----------------------------------------------------------------------------
// GOOGLE TTS — sanitize + synthesize (no URLs or weird characters)
// -----------------------------------------------------------------------------
function sanitizeForSpeech(text) {
  if (!text) return "";

  let t = text
    .split(/\r?\n/)
    .filter((line) => {
      const upper = line.trim().toUpperCase();
      if (upper.startsWith("QUIZ:")) return false;
      if (upper.startsWith("VIDEO:")) return false;
      if (upper.startsWith("ARTICLE:")) return false;
      return true;
    })
    .join(" ");

  t = t.replace(/QUIZ:\s*{[^}]*}/gi, " ");
  t = t.replace(/VIDEO:\s*{[^}]*}/gi, " ");
  t = t.replace(/ARTICLE:\s*{[^}]*}/gi, " ");

  const cutIdx = t.search(/(links:|resources:)/i);
  if (cutIdx !== -1) t = t.slice(0, cutIdx);

  t = t.replace(/https?:\/\/\S+/gi, " ");
  t = t.replace(
    /\b[^\s]+\.(com|net|org|io|ai|edu|co|dev|info)(\/[^\s]*)?/gi,
    " "
  );
  t = t.replace(/\bwww\.[^\s]+/gi, " ");

  t = t.replace(/`[^`]*`/g, " ");
  t = t.replace(/[*_>#\-]+/g, " ");
  t = t.replace(/[•~_=^]+/g, " ");
  t = t.replace(/[\[\]\(\)\{\}<>\/\\|]+/g, " ");
  t = t.replace(/[;:]{2,}/g, " ");

  t = t.replace(/\bExcel\b/gi, "Microsoft Excel");
  t = t.replace(/\s{2,}/g, " ");

  return t.trim();
}

async function synthesizeWithGoogleTTS(fullText) {
  const spoken = sanitizeForSpeech(fullText);
  if (!spoken) return null;

  const request = {
    input: { text: spoken },
    voice: {
      languageCode: "en-GB",
      ssmlGender: "MALE",
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: 0.95,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  if (!response.audioContent) return null;
  const audioBase64 = response.audioContent.toString("base64");
  return { audioBase64, mimeType: "audio/mpeg" };
}

// -----------------------------------------------------------------------------
// Optional HTTP /api/chat (non-WS clients)
// -----------------------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { student_email, lmsKey, message, history } = req.body || {};

    if (!student_email || !message) {
      return res.status(400).json({
        error: "student_email and message are required.",
      });
    }

    if (lmsKey && lmsKey !== process.env.MY_LMS_API_KEY) {
      return res.status(403).json({ error: "Invalid LMS key." });
    }

    const studentEmail = normalizeEmail(student_email);
    const scope = await getStudentScope(studentEmail);
    const enrolledCourseNames = scope.courseNames.join(", ");
    const allowedPhrases = scope.allowedPhrases;

    const header = buildContextHeader(
      studentEmail,
      enrolledCourseNames,
      allowedPhrases
    );
    const baseInstruction = `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

    const contents = [];

    if (Array.isArray(history)) {
      for (const h of history) {
        if (!h || !h.text) continue;
        let role = "user";
        if (h.role === "assistant" || h.role === "model") role = "model";
        contents.push({ role, parts: [{ text: h.text }] });
      }
    }

    contents.push({ role: "user", parts: [{ text: message }] });

    const quizMode = isQuizRequest(message);
    const finalInstruction = quizMode
      ? `${baseInstruction}\n\n${QUIZ_MODE_INSTRUCTION}`
      : baseInstruction;

    const aiText = await callGeminiChat({
      systemInstruction: finalInstruction,
      contents,
      maxTokens: quizMode ? 2048 : 512,
    });

    return res.json({ text: aiText, model: getCurrentModelLabel() });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(500).json({
      error: err.message || "Server error",
      model: getCurrentModelLabel(),
    });
  }
});

// -----------------------------------------------------------------------------
// WebSocket /ws — text chat for voice UI (with Google TTS audio) + ping keepalive
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.session = null;

  console.log("WS client connected:", ws.id);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (e) {
        console.error("WS ping error:", e);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad WS JSON:", e);
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // ----- START SESSION -----
    if (msg.type === "start") {
      try {
        if (msg.lmsKey && msg.lmsKey !== process.env.MY_LMS_API_KEY) {
          ws.send(JSON.stringify({ type: "error", error: "Invalid LMS key." }));
          ws.close();
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
        const systemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

        const initialHistory = Array.isArray(msg.history)
          ? msg.history.filter(
              (h) =>
                h &&
                typeof h.text === "string" &&
                (h.role === "user" || h.role === "assistant")
            )
          : [];

        ws.session = {
          studentEmail,
          lmsKey: msg.lmsKey,
          systemInstruction,
          history: initialHistory,
        };

        ws.send(JSON.stringify({ type: "ready" }));
      } catch (err) {
        console.error("WS start error:", err);
        ws.send(
          JSON.stringify({
            type: "error",
            error: err.message || "Failed to start session",
          })
        );
        ws.close();
      }
      return;
    }

    if (!ws.session) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "Session not initialized. Send a 'start' message first.",
        })
      );
      return;
    }

    // ----- USER TEXT -----
    if (msg.type === "user_text") {
      const text = String(msg.text || "").trim();
      if (!text) return;

      const requestId = msg.requestId || crypto.randomUUID();
      ws.session.history.push({ role: "user", text });

      const contents = ws.session.history.map((h) => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.text }],
      }));

      const quizMode = isQuizRequest(text);
      const finalInstruction = quizMode
        ? `${ws.session.systemInstruction}\n\n${QUIZ_MODE_INSTRUCTION}`
        : ws.session.systemInstruction;

      try {
        console.log(
          `[WS ${ws.id}] Gemini call | model=${getCurrentModelLabel()} | user=${ws.session.studentEmail} | msg="${text.substring(
            0,
            100
          )}..."`
        );

        const aiText = await callGeminiChat({
          systemInstruction: finalInstruction,
          contents,
          maxTokens: quizMode ? 2048 : 512,
        });

        ws.session.history.push({ role: "assistant", text: aiText });

        let tts = null;
        try {
          tts = await synthesizeWithGoogleTTS(aiText);
        } catch (ttsErr) {
          console.error("[Voice] Google TTS error:", ttsErr);
        }

        const payload = {
          type: "assistant_text",
          text: aiText,
          requestId,
          model: getCurrentModelLabel(),
        };
        if (tts && tts.audioBase64) {
          payload.audio = tts.audioBase64;
          payload.audioMime = tts.mimeType;
        }

        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error(`[WS ${ws.id}] Gemini error:`, err);

        const errorPayload = {
          type: "error",
          error: err.message || "Gemini error",
          details: {
            model: getCurrentModelLabel(),
            studentEmail: ws.session?.studentEmail,
            apiVersion: GEMINI_API_VERSION,
            ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
          },
        };

        ws.send(JSON.stringify(errorPayload));
      }
      return;
    }

    // ----- STOP -----
    if (msg.type === "stop") {
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    console.log("WS client disconnected:", ws.id);
    clearInterval(pingInterval);
  });

  ws.on("error", (e) => {
    console.error("WS error:", e);
    clearInterval(pingInterval);
  });
});

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Praxis Voice listening on ${PORT} | model=${getCurrentModelLabel()} | apiVersion=${GEMINI_API_VERSION}`);

  // Once resolved, print the real model
  resolveActiveModel()
    .then((m) =>
      console.log(`✅ Gemini model resolved and active: ${m}`)
    )
    .catch((e) =>
      console.warn(`⚠️ Gemini model resolve failed after listen: ${e.message || e}`)
    );
});
