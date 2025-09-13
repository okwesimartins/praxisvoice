// index.js — Praxis bot (Slack + API) using new Pluralcode curriculum API (with sandbox)
// --------------------------------------------------------------------------------------
// Highlights (delta):
// - Robust payload harvesting (topics/subtopics regardless of exact keys)
// - Agile/Scrum synonyms (scrum events/ceremonies + sprint planning/daily/review/retro/refinement)
// - Fuzzy topic matching (token-overlap) to avoid false “out-of-scope”
// - Safer query builder: never falls back to raw user text out-of-scope
// - Meta-queries: “what course am I enrolled in?”
// - Friendly Slack error when Slack email isn’t enrolled

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { App, ExpressReceiver } = require('@slack/bolt');
const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } = require('@google/generative-ai');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const express = require('express');

// --- fetch polyfill (Node < 18) ---
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}
const fetch = (...args) => fetchFn(...args);

// --- Main Setup ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events',
  processBeforeResponse: true
});
receiver.router.use(cors());
receiver.router.use(express.json());

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

const db = new Firestore();
const CONVERSATIONS_COLLECTION = 'conversations';
const EVENT_LOCKS_COLLECTION = 'eventLocks';
const HISTORY_LIMIT = 40;

// --- External APIs ---
const Google_Search_API_KEY = process.env.Google_Search_API_KEY;
const Google_Search_CX_ID = process.env.Google_Search_CX_ID;
const youtube = google.youtube({ version: 'v3', auth: Google_Search_API_KEY });

// -----------------------------------------------------------------------------
// Pluralcode Knowledge Base (authoritative sources)
// -----------------------------------------------------------------------------
const PLURALCODE_KB = {
  officialSite: {
    title: 'Pluralcode Academy — Official Website',
    link: 'https://pluralcode.academy',
    snippet: 'Official site for admissions, programs, schedules, prices, and announcements.'
  },
  courses: [
    { key: /business\s*analytics/i, title: 'Pluralcode — Business Analytics Curriculum', link: 'https://drive.google.com/file/d/1oeCfsw8xn1j0Eluh1QF8H8hbcn5uYUJM/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /cloud/i, title: 'Pluralcode — Cloud Computing Curriculum', link: 'https://drive.google.com/file/d/1uBGIDRMs327_nvvdkLiiTLLzfqdF1OcK/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /cyber\s*security|cybersecurity/i, title: 'Pluralcode — Cyber Security Curriculum', link: 'https://drive.google.com/file/d/1G68zhE2I6gcjWeUY4Z_z0iBPMlLpA67s/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /data\s*analytics?/i, title: 'Pluralcode — Data Analytics Curriculum', link: 'https://drive.google.com/file/d/1vT-ZZjlcFk-_cxjGu3J_YH3ffefVcQA8/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /digital\s*growth/i, title: 'Pluralcode — Digital Growth Curriculum', link: 'https://drive.google.com/file/d/1Wfp9nA3crUypbqo4uitxbq-0P2uYhEyu/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /financial\s*market/i, title: 'Pluralcode — Financial Market Curriculum', link: 'https://drive.google.com/file/d/1r1jCTPgeibzylDVVuY1knDGFJKOF1CPl/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /product\s*design/i, title: 'Pluralcode — Product Design Curriculum', link: 'https://drive.google.com/file/d/1ilRxesCbdRiFMXu7_Cf6Oa1j6hPcuJvq/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /project.*product\s*management|product\s*management|project\s*management/i, title: 'Pluralcode — Project & Product Management Curriculum', link: 'https://drive.google.com/file/d/1nyvLJB-LGgue6zd9vYD8WfKtWCzItrct/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /software\s*dev|software\s*development|programming/i, title: 'Pluralcode — Software Development Curriculum', link: 'https://drive.google.com/file/d/1t32BTxtqxJj-Q9FAADswp2L5XdqgwX0g/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
    { key: /generative\s*ai|prompt\s*engineering/i, title: 'Pluralcode — Generative AI & Prompt Engineering Curriculum', link: 'https://drive.google.com/file/d/1_eECyDpB-tXScy-p0eVYdhKGEITiTfPO/view?usp=sharing', snippet: 'Official course structure, modules, and outcomes.' },
  ]
};

const getKbArticles = (topicRaw = '') => {
  const topic = String(topicRaw || '').toLowerCase();
  const out = [];
  if (/pluralcode(\s+academy)?/.test(topic)) out.push({ ...PLURALCODE_KB.officialSite });
  for (const c of PLURALCODE_KB.courses) {
    if (c.key.test(topic)) out.push({ title: c.title, link: c.link, snippet: c.snippet });
  }
  return out;
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
const withTimeout = async (promise, ms, onTimeoutMsg = 'Timed out') => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(onTimeoutMsg)), ms));
  return Promise.race([promise, timeout]);
};

const isLikelyGoodUrl = (url) => {
  if (!/^https?:\/\//i.test(url)) return false;
  if (/webcache\.googleusercontent\.com|translate\.googleusercontent\.com|accounts\.google\.com/i.test(url)) return false;
  return true;
};

const validateUrl = async (url) => {
  // Always allow KB links (may 302 or block HEAD)
  if (url.includes('pluralcode.academy') || url.includes('drive.google.com')) return true;
  if (!isLikelyGoodUrl(url)) return false;
  try {
    const res = await withTimeout(fetch(url, { method: 'HEAD' }), 3500, 'URL HEAD timeout');
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
  } catch (_) {
    try {
      const res2 = await withTimeout(fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1024' } }), 4500, 'URL GET timeout');
      if (res2.ok || (res2.status >= 300 && res2.status < 400)) return true;
    } catch (__) {}
  }
  return false;
};

const cleanAndValidateResults = async (items, max = 3) => {
  const pruned = [];
  for (const item of (items || [])) {
    if (!item || !item.link) continue;
    if (!isLikelyGoodUrl(item.link)) continue;
    if (await validateUrl(item.link)) pruned.push(item);
    if (pruned.length >= max) break;
  }
  return pruned;
};

// Normalizers
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const norm = (s = '') =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// -----------------------------------------------------------------------------
// Search tools
// -----------------------------------------------------------------------------
async function search_youtube_for_videos({ query }) {
  try {
    const response = await withTimeout(
      youtube.search.list({
        part: 'snippet',
        q: query,
        type: 'video',
        videoEmbeddable: 'true',
        maxResults: 6
      }),
      6000,
      'YouTube search timeout'
    );

    const items = (response.data.items || []).map((it) => ({
      title: it.snippet.title,
      link: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      snippet: it.snippet.description
    }));

    const valid = await cleanAndValidateResults(items, 3);
    return valid.length ? { searchResults: valid } : { message: `No YouTube videos found for "${query}".` };
  } catch (error) {
    return { error: "Failed to search YouTube.", details: error.message };
  }
}

async function search_web_for_articles({ query }) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${Google_Search_API_KEY}&cx=${Google_Search_CX_ID}&q=${encodeURIComponent(query)}`;
  try {
    const res = await withTimeout(fetch(url), 6000, 'Web search timeout');
    if (!res.ok) throw new Error(`Google Search API responded with status ${res.status}`);
    const data = await res.json();
    const items = (data.items || []).map((i) => ({
      title: i.title,
      link: i.link,
      snippet: i.snippet
    }));
    const valid = await cleanAndValidateResults(items, 3);
    return valid.length ? { searchResults: valid } : { message: `No articles found for "${query}".` };
  } catch (error) {
    return { error: "Failed to search web.", details: error.message };
  }
}

const availableTools = { search_youtube_for_videos, search_web_for_articles };

// -----------------------------------------------------------------------------
// Gemini Setup
// -----------------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const toolDefs = [{
  functionDeclarations: [
    {
      name: "search_web_for_articles",
      description: "Search the web for high-quality articles, blog posts, and official documentation.",
      parameters: {
        type: "OBJECT",
        properties: { query: { type: "STRING", description: "A detailed search query." } },
        required: ["query"]
      }
    },
    {
      name: "search_youtube_for_videos",
      description: "Search YouTube for relevant tutorial videos.",
      parameters: {
        type: "OBJECT",
        properties: { query: { type: "STRING", description: "A detailed search query." } },
        required: ["query"]
      }
    }
  ]
}];

const BASE_SYSTEM_INSTRUCTION = `
You are Praxis, a specialized AI tutor for Pluralcode Academy.

PLURALCODE KNOWLEDGE BASE (MANDATORY USAGE)
- Official brand/site info: https://pluralcode.academy.
- Course structure/modules/details must use the official curriculum PDFs (primary source of truth):
  Business Analytics: https://drive.google.com/file/d/1oeCfsw8xn1j0Eluh1QF8H8hbcn5uYUJM/view?usp=sharing
  Cloud Computing: https://drive.google.com/file/d/1uBGIDRMs327_nvvdkLiiTLLzfqdF1OcK/view?usp=sharing
  Cyber Security: https://drive.google.com/file/d/1G68zhE2I6gcjWeUY4Z_z0iBPMlLpA67s/view?usp=sharing
  Data Analytics: https://drive.google.com/file/d/1vT-ZZjlcFk-_cxjGu3J_YH3ffefVcQA8/view?usp=sharing
  Digital Growth: https://drive.google.com/file/d/1Wfp9nA3crUypbqo4uitxbq-0P2uYhEyu/view?usp=sharing
  Financial Market: https://drive.google.com/file/d/1r1jCTPgeibzylDVVuY1knDGFJKOF1CPl/view?usp=sharing
  Product Design: https://drive.google.com/file/d/1ilRxesCbdRiFMXu7_Cf6Oa1j6hPcuJvq/view?usp=sharing
  Project & Product Management: https://drive.google.com/file/d/1nyvLJB-LGgue6zd9vYD8WfKtWCzItrct/view?usp=sharing
  Software Development: https://drive.google.com/file/d/1t32BTxtqxJj-Q9FAADswp2L5XdqgwX0g/view?usp=sharing
  Generative AI & Prompt Engineering: https://drive.google.com/file/d/1_eECyDpB-tXScy-p0eVYdhKGEITiTfPO/view?usp=sharing

CORE RULES
1) Stay strictly within the student's enrolled course scope; sandbox topics are always allowed.
2) When multiple enrolled courses exist, pick the most relevant to the question.
3) For brand/offerings/prices/promotions, rely on the website/socials; for course modules, rely on the curriculum PDFs above.
4) Prefer authoritative sources when searching the web.

FORMATS
- Slack mode: Markdown.
- API mode with "support_format": return explanation + materials.
- API mode with JSON input (topic + format): return ONLY the requested data.

JSON SHAPES
- FAQ: { "data": { "faqs": [ { "question": "...", "answer": "..." } ] } }
- Quiz: { "data": { "topic": "...", "questions": [ { "question_text": "...", "options": ["...","...","...","..."], "correct_answer": "<answer text>" } ] } }

Do NOT invent links. Use KB links for Pluralcode questions when applicable.
`;

// Utility to start a chat
const startChat = (history, opts = {}) =>
  genAI.getGenerativeModel({
    model: "gemini-1.5-pro",
    safetySettings,
    tools: toolDefs,
    systemInstruction: BASE_SYSTEM_INSTRUCTION,
    generationConfig: opts.generationConfig || undefined,
  }).startChat({ history });

// -----------------------------------------------------------------------------
// History + State
// -----------------------------------------------------------------------------
const getConversationHistory = async (sessionId) => {
  const doc = await db.collection(CONVERSATIONS_COLLECTION).doc(sessionId).get();
  return doc.exists ? (doc.data().history || []) : [];
};

const saveToHistory = async (sessionId, userMessage, modelResponse, stateUpdates = null) => {
  const docRef = db.collection(CONVERSATIONS_COLLECTION).doc(sessionId);
  const current = await docRef.get();
  let history = current.exists ? (current.data().history || []) : [];
  history = history.concat([
    { role: 'user', parts: [{ text: userMessage }] },
    { role: 'model', parts: [{ text: modelResponse }] }
  ]);
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);

  const data = { history, last_updated: Timestamp.now() };
  if (stateUpdates && typeof stateUpdates === 'object') Object.assign(data, stateUpdates);

  await docRef.set(data, { merge: true });
};

const getConvState = async (sessionId) => {
  const doc = await db.collection(CONVERSATIONS_COLLECTION).doc(sessionId).get();
  const data = doc.exists ? doc.data() : {};
  return {
    lastTopic: data.lastTopic || null,
    lastFormat: data.lastFormat || null,
    lastCourse: data.lastCourse || null,
    lastSearchQuery: data.lastSearchQuery || null,
    allowedPhrases: data.allowedPhrases || null,
    formatBlocklist: Array.isArray(data.formatBlocklist) ? data.formatBlocklist : [],
    preferredFormat: data.preferredFormat || null,
  };
};

const updateConvState = async (sessionId, updates) => {
  await db.collection(CONVERSATIONS_COLLECTION).doc(sessionId).set(
    { ...updates, last_updated: Timestamp.now() },
    { merge: true }
  );
};

const acquireEventLock = async (eventId) => {
  const lockRef = db.collection(EVENT_LOCKS_COLLECTION).doc(eventId);
  try {
    await db.runTransaction(async (t) => {
      const lockDoc = await t.get(lockRef);
      if (lockDoc.exists) throw new Error('Event lock already exists.');
      t.set(lockRef, { createdAt: Timestamp.now() });
    });
    return true;
  } catch (error) {
    if (error.message.includes('Event lock')) return false;
    throw error;
  }
};

// -----------------------------------------------------------------------------
// New Pluralcode API integration (enrolled courses + curriculum + sandbox)
// -----------------------------------------------------------------------------
const PLURALCODE_API_BASE = process.env.PLURALCODE_API_URL || 'https://backend.pluralcode.institute';

// Synonyms
const addSynonyms = (phrase, bag) => {
  const raw = String(phrase || '');
  const display = raw.trim();
  const p = display.toLowerCase();
  if (!display) return bag;
  bag.add(display); // keep original phrase

  // Common tech synonyms
  if (/javascript/.test(p)) { bag.add('javascript'); bag.add('js'); }
  if (/power\s*bi|powerbi|pbi/.test(p)) { bag.add('power bi'); bag.add('pbi'); bag.add('powerbi'); }
  if (/vlookup/.test(p)) { bag.add('vlookup'); }
  if (/hlookup/.test(p)) { bag.add('hlookup'); }
  if (/\bsql\b/.test(p)) { bag.add('sql'); }
  if (/excel/.test(p)) { bag.add('excel'); }
  if (/python/.test(p)) { bag.add('python'); }
  if (/machine\s*learning/.test(p)) { bag.add('ml'); bag.add('machine learning'); }
  if (/\bux\b|user\s*experience/.test(p)) { bag.add('ux'); bag.add('user experience'); }
  if (/\bui\b|user\s*interface/.test(p)) { bag.add('ui'); bag.add('user interface'); }
  if (/data\s*analytics?/.test(p)) { bag.add('data analytics'); }
  if (/web\s*scraping/.test(p)) { bag.add('web scraping'); }
  if (/dax/.test(p)) { bag.add('dax'); }

  // Agile/Scrum domain
  if (/\bscrum\b/.test(p) || /\bagile\b/.test(p)) {
    bag.add('scrum'); bag.add('agile');
    bag.add('scrum events'); bag.add('scrum ceremonies'); bag.add('agile ceremonies');
    bag.add('sprint planning'); bag.add('daily scrum'); bag.add('daily standup');
    bag.add('sprint review'); bag.add('sprint retrospective');
    bag.add('backlog refinement'); bag.add('product backlog refinement');
  }
  if (/kanban/.test(p)) { bag.add('kanban'); }

  return bag;
};

// Payload harvester (tolerant to shape)
const TOPIC_STRING_KEYS = new Set([
  'coursename','course','course_name','name','title','topic','topic_name','label',
  'module','module_name','lesson','lesson_name','chapter','section','unit'
]);
const TOPIC_ARRAY_KEYS = new Set([
  'course_topics','topics','sub_topic','sub_topics','children','modules','lessons','chapters','sections','units','items'
]);

function harvestCourseStrings(node, bag) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const it of node) harvestCourseStrings(it, bag);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const key = String(k).toLowerCase();
      if (typeof v === 'string') {
        if (TOPIC_STRING_KEYS.has(key)) {
          const s = v.trim();
          if (s && !/^https?:\/\//i.test(s) && s.length <= 200) addSynonyms(s, bag);
        }
      } else if (Array.isArray(v)) {
        // Traverse arrays whether or not the key matches the shortlist (defensive)
        for (const child of v) harvestCourseStrings(child, bag);
      } else if (typeof v === 'object' && v) {
        harvestCourseStrings(v, bag);
      }
    }
  }
}

const buildAllowedFromPayload = (data) => {
  const phrases = new Set();
  const courseNames = [];

  try {
    const enrolled = Array.isArray(data.enrolled_courses) ? data.enrolled_courses : [];
    for (const c of enrolled) {
      const courseName = (c.coursename || c.course_name || c.name || c.title || '').trim();
      if (courseName) {
        courseNames.push(courseName);
        addSynonyms(courseName, phrases);
      }
      // Harvest topics/subtopics robustly
      if (c.course_topics) harvestCourseStrings(c.course_topics, phrases);
      else harvestCourseStrings(c, phrases);
    }
    const sandbox = Array.isArray(data.sandbox) ? data.sandbox : [];
    for (const s of sandbox) harvestCourseStrings(s, phrases);
  } catch (_) { /* ignore */ }

  return {
    courseNames,
    allowedPhrases: Array.from(phrases)
  };
};

const getStudentScope = async (email) => {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error("Student email is missing.");
  const url = `${PLURALCODE_API_BASE}/student/praxis_get_student_courses?email=${encodeURIComponent(clean)}`;
  try {
    const response = await withTimeout(fetch(url), 8000, 'Pluralcode API timeout');
    if (!response.ok) throw new Error(`Pluralcode API failed with status ${response.status}`);
    const data = await response.json();
    const scope = buildAllowedFromPayload(data);
    if (!scope.courseNames.length) throw new Error('No active course enrollment found.');
    if (process.env.DEBUG_SCOPE === '1') {
      console.debug('Parsed scope', { email: clean, courses: scope.courseNames, phrasesCount: scope.allowedPhrases.length, sample: scope.allowedPhrases.slice(0, 30) });
    }
    return scope;
  } catch (error) {
    throw new Error("Could not verify student enrollment.");
  }
};

// -----------------------------------------------------------------------------
// Intent/topic resolution + Query building
// -----------------------------------------------------------------------------
const extractExplicitTopic = (msg = '') => {
  const s = String(msg || '');
  const mQuote = s.match(/["“”']([^"“”']{3,120})["“”']/);
  if (mQuote) return mQuote[1].trim();
  const mAbout = s.match(/\b(?:about|on|regarding|re:?)(?:\s+)([^.?]{3,140})/i);
  if (mAbout) return mAbout[1].replace(/\b(them|it|this|that|the subject)\b/gi, '').trim();
  return null;
};

const normalizeQuery = (q = '') => {
  let t = q.toLowerCase();
  t = t.replace(/\b(give me|show me|videos?|articles?|materials?|docs?|documentation|please|kindly|about|on|regarding|explain|teach|tell me|the subject)\b/gi, '');
  t = t.replace(/\b(them|it|this|that)\b/gi, '');
  t = t.replace(/[^\w\s\-\+\&\/]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const words = t.split(' ').slice(0, 12);
  return words.join(' ').trim();
};

// Meta: asking what course they’re enrolled in
const isEnrollmentMetaQuery = (msg = '') => {
  const m = norm(msg);
  return /\b(what|which)\b.*\b(course|program|track)s?\b.*\b(enroll|enrolled|registered|taking)\b/.test(m)
      || /\b(am i|my)\b.*\b(enrolled|course|program|track)\b/.test(m)
      || /\b(which course am i (in|enrolled in))\b/.test(m);
};

// Negation helpers ------------------------------------------------------------
const NEG_WORDS = ['don\'t', 'dont', 'do not', 'no', 'without', 'except', 'stop', 'never', 'no more', 'anymore', 'not'];

// Ensure regex is global for matchAll()
const toGlobal = (re) => {
  if (!re) return re;
  const flags = re.flags && re.flags.includes('g') ? re.flags : (re.flags || '') + 'g';
  return new RegExp(re.source, flags);
};

const hasNegationNear = (lower, reTerm) => {
  const re = toGlobal(reTerm);
  const matches = [...lower.matchAll(re)];
  for (const m of matches) {
    const start = Math.max(0, m.index - 20);
    const end = Math.min(lower.length, m.index + (m[0]?.length || 0) + 20);
    const window = lower.slice(start, end);
    if (NEG_WORDS.some(n => window.includes(n))) return true;
  }
  return false;
};

// Detect intent (format) with negation + persistence
const detectFormatFromMessage = (lower, state) => {
  const videoRe   = /\bvideo(s)?\b|\byoutube\b/gi;
  const articleRe = /\barticle(s)?\b|\bmaterial(s)?\b|\bdoc(s|umentation)?\b|\bguide\b|\bblog\b/gi;
  const textRe    = /\b(explain|explanation|teach me|just explain|write\s*up|notes|overview)\b/gi;
  const quizRe    = /\b(quiz|test|assessment|exam|practice\s*(test|questions?)|challenge|test\s*me)\b/gi;
  const faqRe     = /\b(faqs?|q\s*&\s*a|frequently\s*asked\s*questions)\b/gi;

  const avoids = new Set(state?.formatBlocklist || []);
  if (hasNegationNear(lower, videoRe) || /\btext only\b/.test(lower)) avoids.add('video');
  if (hasNegationNear(lower, articleRe)) avoids.add('article');

  const wants = {
    quiz: quizRe.test(lower),
    faq: faqRe.test(lower),
    video: videoRe.test(lower) && !hasNegationNear(lower, videoRe),
    article: articleRe.test(lower) && !hasNegationNear(lower, articleRe),
    text: textRe.test(lower) || /\bjust\s*(teach|explain)\b/.test(lower) || /\btext only\b/.test(lower),
  };

  // precedence: quiz > faq > video > article > text
  let format = null;
  if (wants.quiz) format = 'quiz';
  else if (wants.faq) format = 'faq';
  else if (wants.video && !avoids.has('video')) format = 'video';
  else if (wants.article && !avoids.has('article')) format = 'article';
  else if (wants.text) format = 'text';

  return { format, avoids };
};

// Persist preferences (e.g., "no more videos")
const updateFormatPrefsFromMessage = async (sessionId, lower) => {
  const state = await getConvState(sessionId);
  let block = new Set(state.formatBlocklist || []);
  let preferred = state.preferredFormat || null;

  const videoRe   = /\bvideo(s)?\b|\byoutube\b/gi;
  const articleRe = /\barticle(s)?\b|\bmaterial(s)?\b|\bdoc(s|umentation)?\b/gi;

  if (hasNegationNear(lower, videoRe) || /\btext only\b/.test(lower) || /\bno\s*more\s*videos?\b/.test(lower)) {
    block.add('video');
    preferred = preferred || (/(just\s*explain|text only)/.test(lower) ? 'text' : null);
  }
  if (hasNegationNear(lower, articleRe) || /\bno\s*more\s*articles?\b/.test(lower)) block.add('article');

  await updateConvState(sessionId, { formatBlocklist: Array.from(block), preferredFormat: preferred });
};

const bestPhraseMatch = (msg = '', phrases = []) => {
  if (!msg || !phrases || !phrases.length) return null;
  const m = msg.toLowerCase();
  let best = null;
  for (const p of phrases) {
    const pp = String(p).toLowerCase();
    if (pp && m.includes(pp)) {
      if (!best || pp.length > best.value.length) best = { value: pp, original: p };
    }
  }
  return best ? best.original : null;
};

// NEW: fuzzy token-overlap
function bestFuzzyMatch(msg = '', phrases = []) {
  if (!msg || !phrases?.length) return null;
  const toks = new Set(String(msg).toLowerCase().match(/\b[a-z0-9]+\b/g) || []);
  let best = null;

  for (const ph of phrases) {
    const ptoks = new Set(String(ph).toLowerCase().match(/\b[a-z0-9]+\b/g) || []);
    const inter = [...ptoks].filter(t => toks.has(t));
    const score = inter.length / Math.max(1, ptoks.size);
    const hasStrong = inter.some(t => ['scrum','agile','kanban','sprint','review','retrospective','backlog','ceremonies','events'].includes(t));
    const weighted = score + (hasStrong ? 0.5 : 0);
    if (!best || weighted > best.score) best = { phrase: ph, score: weighted };
  }
  return best && best.score >= 0.35 ? best.phrase : null;
}

const synthesizeSearchQueryWithLLM = async (history, fallback = '') => {
  try {
    const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
    const res = await chat.sendMessage(
      `From the recent conversation, extract the single most relevant topic to search for learning materials (<= 8 words).
Return strict JSON: {"query":"..."}`);
    const text = res?.response?.text?.() || '';
    const parsed = JSON.parse(text || '{}');
    if (parsed && typeof parsed.query === 'string' && parsed.query.trim().length) {
      return parsed.query.trim();
    }
  } catch (_) { /* ignore */ }
  return fallback || '';
};

const buildSearchQuery = async ({ sessionId, userMessage, defaultTopic, allowedPhrases }) => {
  const explicit = extractExplicitTopic(userMessage);
  if (explicit) return normalizeQuery(explicit);

  const best = bestPhraseMatch(userMessage, allowedPhrases || []) || bestFuzzyMatch(userMessage, allowedPhrases || []);
  if (best) return normalizeQuery(best);

  const state = await getConvState(sessionId);
  if (state.lastSearchQuery) return normalizeQuery(state.lastSearchQuery);

  if (defaultTopic) {
    const n = normalizeQuery(defaultTopic);
    if (n) return n;
  }
  const history = await getConversationHistory(sessionId);
  // Never fall back to raw user text; keep in-scope
  const synthesized = await synthesizeSearchQueryWithLLM(history, '');
  const safe = (allowedPhrases && allowedPhrases[0]) || defaultTopic || '';
  return normalizeQuery(synthesized || safe);
};

// Prompt header helpers to avoid scope false-negatives
const summarizeAllowed = (arr, n = 80) => {
  if (!Array.isArray(arr) || !arr.length) return '(none)';
  const head = arr.slice(0, n).join(' • ');
  return head + (arr.length > n ? ` • (+${arr.length - n} more)` : '');
};

const buildContextHeader = (studentEmail, enrolledCourseNames, allowedPhrases, resolvedTopic) => {
  const sample = summarizeAllowed(allowedPhrases, 80);
  return `[CONTEXT]
Student Email: ${studentEmail}
Enrolled Course(s): "${enrolledCourseNames}"
[ALLOWED TOPICS SAMPLE] (truncated): ${sample}
[RESOLVED TOPIC]: ${resolvedTopic}
[POLICY] Answer ONLY if the topic is within the student's curriculum/sandbox. If out of scope, briefly say it's outside their program and offer 2–3 in-scope alternatives. Avoid placeholders; use concrete details from the curriculum.`;
};

const resolveIntentAndTopic = async ({ sessionId, userMessage, allowedPhrases }) => {
  const lower = (userMessage || '').toLowerCase();

  // Detect format intent (negation-aware + persistent blocklist)
  const state = await getConvState(sessionId);
  const { format: detectedFormat } = detectFormatFromMessage(lower, state);

  let topic = extractExplicitTopic(userMessage);
  if (!topic) topic = bestPhraseMatch(userMessage, allowedPhrases || []);
  if (!topic) topic = bestFuzzyMatch(userMessage, allowedPhrases || []); // fuzzy rescue
  if (!topic) topic = state.lastTopic; // follow-up fallback

  // If user has a preferredFormat (e.g., set by "text only" earlier), use it when no explicit format now
  let format = detectedFormat || state.preferredFormat || null;

  return { topic, format, state };
};

// -----------------------------------------------------------------------------
// Tool-call loop
// -----------------------------------------------------------------------------
const runWithToolsIfNeeded = async (chat, prompt) => {
  let result = await chat.sendMessage(prompt);

  for (let i = 0; i < 3; i++) {
    const calls = result?.response?.functionCalls?.() || [];
    if (!calls.length) break;

    const toolResponses = await Promise.all(
      calls.map(async (call) => {
        const fn = availableTools[call.name];
        if (!fn) return null;
        const toolResult = await fn(call.args || {});
        return {
          functionResponse: {
            name: call.name,
            response: {
              name: call.name,
              content: [{ text: JSON.stringify(toolResult) }]
            }
          }
        };
      })
    );

    result = await chat.sendMessage(toolResponses.filter(Boolean));
  }
  return result?.response?.text?.() || '';
};

// Quiz sanitizers
const stripLabel = (s) => (typeof s === 'string' ? s.replace(/^\s*[A-D]\s*[\.\)]\s*/i, '').trim() : s);
const letterToIndex = (ch) => {
  const m = String(ch || '').trim().toUpperCase().match(/^[A-D]$/);
  if (!m) return -1;
  return m[0].charCodeAt(0) - 'A'.charCodeAt(0);
};

// -----------------------------------------------------------------------------
// Unified orchestrator
// -----------------------------------------------------------------------------
async function processUserRequest({ sessionId, userMessage, studentEmail, supportFormat = null, responseMode = 'slack' }) {
  // Update prefs first (so a message like "don't send videos anymore" is memorized)
  await updateFormatPrefsFromMessage(sessionId, String(userMessage || '').toLowerCase());

  // Get enriched student scope
  const studentScope = await getStudentScope(studentEmail);
  const enrolledCourseNames = studentScope.courseNames.join(', ');
  const allowedPhrases = studentScope.allowedPhrases;

  // Persist allowed phrases in conv-state so future turns (even if API fetch fails) still have scope
  await updateConvState(sessionId, { allowedPhrases, lastCourse: enrolledCourseNames });

  // Meta: “what course am I enrolled in?”
  if (isEnrollmentMetaQuery(userMessage)) {
    const courseList = studentScope.courseNames.length ? `You’re enrolled in: **${studentScope.courseNames.join(', ')}**.` : `I couldn’t find active enrollments.`;
    if (responseMode === 'api') return { json: { data: { content: courseList } } };
    return { text: courseList };
  }

  // Parse JSON array input: [{"course_topic":"...", "format":"..."}]
  let parsedInput = null;
  try {
    const tmp = JSON.parse(userMessage);
    if (Array.isArray(tmp) && tmp.length && typeof tmp[0].course_topic === 'string' && typeof tmp[0].format === 'string') {
      parsedInput = { topic: tmp[0].course_topic, format: tmp[0].format.toLowerCase() };
    }
  } catch (_) {}

  const { topic: resolvedTopic, format: resolvedFormat, state } = await resolveIntentAndTopic({ sessionId, userMessage, allowedPhrases });

  // ----------------- API: JSON array payload → DATA ONLY ----------------------
  if (responseMode === 'api' && parsedInput) {
    const { topic, format } = parsedInput;
    const queryFromTopic = await buildSearchQuery({ sessionId, userMessage: topic, defaultTopic: topic, allowedPhrases });
    await updateConvState(sessionId, { lastTopic: topic, lastFormat: format, lastCourse: enrolledCourseNames, lastSearchQuery: queryFromTopic });

    if (format === 'video') {
      const out = await search_youtube_for_videos({ query: queryFromTopic });
      const payload = { data: out.searchResults || [] };
      await saveToHistory(sessionId, `JSON(video): ${topic}`, JSON.stringify(payload), { lastTopic: topic, lastFormat: 'video', lastSearchQuery: queryFromTopic });
      return { json: payload };
    }

    if (format === 'article') {
      const kb = getKbArticles(topic);
      const out = await search_web_for_articles({ query: queryFromTopic });
      const merged = [...kb, ...(out.searchResults || [])];
      const payload = { data: merged };
      await saveToHistory(sessionId, `JSON(article): ${topic}`, JSON.stringify(payload), { lastTopic: topic, lastFormat: 'article', lastSearchQuery: queryFromTopic });
      return { json: payload };
    }

    if (format === 'faq') {
      const history = await getConversationHistory(sessionId);
      const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
      const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topic);
      const prompt = `${header}

[TASK]
Generate 3-5 FAQs strictly as JSON focused on the topic:
"${topic}"

Return EXACTLY:
{ "data": { "faqs": [ { "question": "...", "answer": "..." } ] } }`;
      const text = await runWithToolsIfNeeded(chat, prompt);
      let payload = { data: { faqs: [] } };
      try {
        const parsed = JSON.parse(text);
        payload = parsed?.data?.faqs ? parsed : payload;
      } catch {}
      await saveToHistory(sessionId, `JSON(faq): ${topic}`, JSON.stringify(payload), { lastTopic: topic, lastFormat: 'faq', lastSearchQuery: queryFromTopic });
      return { json: payload };
    }

    if (format === 'quiz') {
      // 1) Generate quiz with answer TEXT + plain options
      const history = await getConversationHistory(sessionId);
      const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
      const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topic);
      const prompt = `${header}

[TASK]
Generate a 10-question multiple-choice quiz as strict JSON.
- "options": array of 4 plain strings (no "A."/ "B.")
- "correct_answer": the exact option text (not a letter)

Topic: "${topic}"

Return EXACTLY:
{
  "data": {
    "topic": "${topic}",
    "questions": [
      { "question_text": "...", "options": ["...","...","...","..."], "correct_answer": "..." }
    ]
  }
}`;
      const text = await runWithToolsIfNeeded(chat, prompt);
      let quiz = { data: { topic, questions: [] } };
      try { quiz = JSON.parse(text); } catch {}

      // 2) Sanitize answers/options
      const questions = Array.isArray(quiz?.data?.questions) ? quiz.data.questions : [];
      for (const q of questions) {
        q.options = Array.isArray(q.options) ? q.options.map(stripLabel) : [];
        if (typeof q.correct_answer === 'string') {
          const idx = letterToIndex(q.correct_answer);
          if (idx >= 0 && idx < q.options.length) q.correct_answer = q.options[idx];
          else q.correct_answer = stripLabel(q.correct_answer);
        } else {
          q.correct_answer = '';
        }
      }

      // 3) Enrich with validated articles (plus KB if relevant)
      for (const q of questions) {
        const kb = getKbArticles(topic);
        const qText = typeof q?.question_text === 'string' ? q.question_text : '';
        let arts = [];
        if (qText) {
          const query = `${normalizeQuery(topic)} ${normalizeQuery(qText)} site:w3schools.com OR site:geeksforgeeks.org OR site:sqlbolt.com OR site:mode.com OR site:docs.microsoft.com OR site:postgresql.org`;
          const out = await search_web_for_articles({ query });
          arts = (out.searchResults || []).slice(0, 2);
        }
        q.articles = [...kb.slice(0, 1), ...arts];
      }

      const payload = { data: { topic, questions } };
      await saveToHistory(sessionId, `JSON(quiz): ${topic}`, JSON.stringify(payload), { lastTopic: topic, lastFormat: 'quiz', lastSearchQuery: queryFromTopic });
      return { json: payload };
    }

    const payload = { data: [] };
    await saveToHistory(sessionId, `JSON(unknown): ${parsedInput.topic}`, JSON.stringify(payload), { lastTopic: parsedInput.topic, lastFormat: 'text' });
    return { json: payload };
  }

  // ------------- API: support_format → EXPLANATION + MATERIALS ----------------
  if (responseMode === 'api' && supportFormat) {
    const fmt = (supportFormat || '').toLowerCase();
    const topicForMaterials = resolvedTopic || state.lastTopic || userMessage;

    const query = await buildSearchQuery({ sessionId, userMessage, defaultTopic: topicForMaterials, allowedPhrases });
    await updateConvState(sessionId, { lastTopic: topicForMaterials, lastFormat: fmt, lastCourse: enrolledCourseNames, lastSearchQuery: query });

    const history = await getConversationHistory(sessionId);
    const chat = startChat(history);
    const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicForMaterials);
    const prompt = `${header}

[QUERY]
${userMessage}

[INSTRUCTIONS]
Write a friendly, accurate explanation strictly within the allowed curriculum. Use 3–6 concrete bullets (from the course content), then end with ONE short check-for-understanding question.
Do NOT use placeholders like "Key idea #1". If the topic is out of scope, say so briefly and suggest 2–3 in-scope alternatives.`;
    const explanation = await runWithToolsIfNeeded(chat, prompt);

    let materials = {};
    if (fmt === 'video') {
      const out = await search_youtube_for_videos({ query });
      materials.videos = out.searchResults || [];
    } else if (fmt === 'article') {
      const kb = getKbArticles(query);
      const out = await search_web_for_articles({ query });
      materials.articles = [...kb, ...(out.searchResults || [])];
    }

    const payload = { data: { content: explanation, materials } };
    await saveToHistory(sessionId, `API(${fmt}): ${query}`, JSON.stringify(payload), { lastTopic: topicForMaterials, lastFormat: fmt, lastSearchQuery: query });
    return { json: payload };
  }

  // ---- API: plain text smart when no support_format and not JSON -------------
  if (responseMode === 'api' && !supportFormat && !parsedInput) {
    const requestedFormat = resolvedFormat || state.preferredFormat || 'text';
    const topicBase = resolvedTopic || state.lastTopic || (allowedPhrases && allowedPhrases[0]) || 'Getting started';
    const query = await buildSearchQuery({ sessionId, userMessage, defaultTopic: topicBase, allowedPhrases });
    await updateConvState(sessionId, { lastTopic: topicBase, lastFormat: requestedFormat, lastCourse: enrolledCourseNames, lastSearchQuery: query });

    if (requestedFormat === 'video') {
      const out = await search_youtube_for_videos({ query });
      const payload = { data: out.searchResults || [] };
      await saveToHistory(sessionId, `API(video): ${query}`, JSON.stringify(payload), { lastSearchQuery: query });
      return { json: payload };
    }
    if (requestedFormat === 'article') {
      const kb = getKbArticles(query);
      const out = await search_web_for_articles({ query });
      const payload = { data: [...kb, ...(out.searchResults || [])] };
      await saveToHistory(sessionId, `API(article): ${query}`, JSON.stringify(payload), { lastSearchQuery: query });
      return { json: payload };
    }
    if (requestedFormat === 'faq') {
      const history = await getConversationHistory(sessionId);
      const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
      const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicBase);
      const prompt = `${header}

[TASK]
Generate 3-5 FAQs strictly as JSON on the topic:
"${topicBase}"

Return EXACTLY:
{ "data": { "faqs": [ { "question": "...", "answer": "..." } ] } }`;
      const text = await runWithToolsIfNeeded(chat, prompt);
      let payload = { data: { faqs: [] } };
      try { payload = JSON.parse(text); } catch {}
      await saveToHistory(sessionId, `API(faq): ${query}`, JSON.stringify(payload), { lastSearchQuery: query });
      return { json: payload };
    }
    if (requestedFormat === 'quiz') {
      // quiz: text answers + plain options + per-question articles
      const history = await getConversationHistory(sessionId);
      const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
      const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicBase);
      const prompt = `${header}

[TASK]
Generate a 10-question multiple-choice quiz as strict JSON.
- "options": array of 4 plain strings (no "A."/ "B.")
- "correct_answer": the exact option text (not a letter)

Topic: "${topicBase}"

Return EXACTLY:
{
  "data": {
    "topic": "${topicBase}",
    "questions": [
      { "question_text": "...", "options": ["...","...","...","..."], "correct_answer": "..." }
    ]
  }
}`;
      const text = await runWithToolsIfNeeded(chat, prompt);
      let quiz = { data: { topic: topicBase, questions: [] } };
      try { quiz = JSON.parse(text); } catch {}

      const questions = Array.isArray(quiz?.data?.questions) ? quiz.data.questions : [];
      for (const q of questions) {
        q.options = Array.isArray(q.options) ? q.options.map(stripLabel) : [];
        if (typeof q.correct_answer === 'string') {
          const idx = letterToIndex(q.correct_answer);
          if (idx >= 0 && idx < q.options.length) q.correct_answer = q.options[idx];
          else q.correct_answer = stripLabel(q.correct_answer);
        } else {
          q.correct_answer = '';
        }
      }
      for (const q of questions) {
        const kb = getKbArticles(topicBase);
        const qText = typeof q?.question_text === 'string' ? q.question_text : '';
        let arts = [];
        if (qText) {
          const qQuery = `${normalizeQuery(topicBase)} ${normalizeQuery(qText)} site:w3schools.com OR site:geeksforgeeks.org OR site:sqlbolt.com OR site:mode.com OR site:docs.microsoft.com OR site:postgresql.org`;
          const out = await search_web_for_articles({ query: qQuery });
          arts = (out.searchResults || []).slice(0, 2);
        }
        q.articles = [...kb.slice(0, 1), ...arts];
      }

      const payload = { data: { topic: topicBase, questions } };
      await saveToHistory(sessionId, `API(quiz): ${query}`, JSON.stringify(payload), { lastSearchQuery: query });
      return { json: payload };
    }

    // default explanation
    const history = await getConversationHistory(sessionId);
    const chat = startChat(history);
    const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicBase);
    const prompt = `${header}

[QUERY]
${userMessage}

[INSTRUCTIONS]
Explain clearly and concisely strictly within the enrolled curriculum. Use concrete bullets taken from the course content (no placeholders), and finish with ONE short question to check understanding. If the request is out of scope, say so briefly and suggest 2–3 in-scope alternatives.`;
    const explanation = await runWithToolsIfNeeded(chat, prompt);
    const payload = { data: { content: explanation } };
    await saveToHistory(sessionId, `API(text): ${topicBase}`, JSON.stringify(payload), { lastSearchQuery: await buildSearchQuery({ sessionId, userMessage, defaultTopic: topicBase, allowedPhrases }) });
    return { json: payload };
  }

  // ----------------------------- Slack mode -----------------------------------
  const requestedFormat = resolvedFormat || null;
  const topicForSlack = resolvedTopic || state.lastTopic || (allowedPhrases && allowedPhrases[0]) || 'Getting started';
  const query = await buildSearchQuery({ sessionId, userMessage, defaultTopic: topicForSlack, allowedPhrases });

  await updateConvState(sessionId, { lastTopic: topicForSlack, lastFormat: requestedFormat || state.preferredFormat || 'text', lastCourse: enrolledCourseNames, lastSearchQuery: query });

  if (requestedFormat === 'video') {
    const out = await search_youtube_for_videos({ query });
    const vids = out.searchResults || [];
    if (!vids.length) {
      const text = `I couldn't find reliable videos for **${topicForSlack}**.`;
      await saveToHistory(sessionId, userMessage, text, { lastSearchQuery: query });
      return { text };
    }
    const md = vids.map(v => `**${v.title}**\n${v.link}\n> ${v.snippet}`).join('\n\n');
    await saveToHistory(sessionId, userMessage, md, { lastSearchQuery: query });
    return { text: md };
  }

  if (requestedFormat === 'article') {
    const kb = getKbArticles(query);
    const out = await search_web_for_articles({ query });
    const arts = [...kb, ...(out.searchResults || [])];
    if (!arts.length) {
      const text = `I couldn't find reliable articles for **${topicForSlack}**.`;
      await saveToHistory(sessionId, userMessage, text, { lastSearchQuery: query });
      return { text };
    }
    const md = arts.map(a => `**${a.title}**\n${a.link}\n> ${a.snippet}`).join('\n\n');
    await saveToHistory(sessionId, userMessage, md, { lastSearchQuery: query });
    return { text: md };
  }

  if (requestedFormat === 'faq') {
    const history = await getConversationHistory(sessionId);
    const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
    const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicForSlack);
    const prompt = `${header}

[TASK]
Generate 3-5 FAQs strictly as JSON on the topic:
"${topicForSlack}"

Return EXACTLY:
{ "data": { "faqs": [ { "question": "...", "answer": "..." } ] } }`;
    const text = await runWithToolsIfNeeded(chat, prompt);
    let payload = { data: { faqs: [] } };
    try { payload = JSON.parse(text); } catch {}
    const faqs = Array.isArray(payload?.data?.faqs) ? payload.data.faqs : [];
    const md = faqs.length
      ? faqs.map((f, i) => `**Q${i+1}. ${f.question}**\n${f.answer}`).join('\n\n')
      : 'I could not generate FAQs right now.';
    await saveToHistory(sessionId, userMessage, md, { lastSearchQuery: query });
    return { text: md };
  }

  if (requestedFormat === 'quiz') {
    const history = await getConversationHistory(sessionId);
    const chat = startChat(history, { generationConfig: { responseMimeType: 'application/json' } });
    const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicForSlack);
    const prompt = `${header}

[TASK]
Generate a 10-question multiple-choice quiz as strict JSON.
- "options": array of 4 plain strings (no "A."/ "B.")
- "correct_answer": the exact option text (not a letter)

Topic: "${topicForSlack}"

Return EXACTLY:
{
  "data": {
    "topic": "${topicForSlack}",
    "questions": [
      { "question_text": "...", "options": ["...","...","...","..."], "correct_answer": "..." }
    ]
  }
}`;
    const text = await runWithToolsIfNeeded(chat, prompt);
    let quiz = { data: { topic: topicForSlack, questions: [] } };
    try { quiz = JSON.parse(text); } catch {}

    const questions = Array.isArray(quiz?.data?.questions) ? quiz.data.questions : [];
    for (const q of questions) {
      q.options = Array.isArray(q.options) ? q.options.map(stripLabel) : [];
      if (typeof q.correct_answer === 'string') {
        const idx = letterToIndex(q.correct_answer);
        if (idx >= 0 && idx < q.options.length) q.correct_answer = q.options[idx];
        else q.correct_answer = stripLabel(q.correct_answer);
      } else {
        q.correct_answer = '';
      }
    }
    for (const q of questions) {
      const kb = getKbArticles(topicForSlack);
      const qText = typeof q?.question_text === 'string' ? q.question_text : '';
      let arts = [];
      if (qText) {
        const qQuery = `${normalizeQuery(topicForSlack)} ${normalizeQuery(qText)} site:w3schools.com OR site:geeksforgeeks.org OR site:sqlbolt.com OR site:mode.com OR site:docs.microsoft.com OR site:postgresql.org`;
        const out = await search_web_for_articles({ query: qQuery });
        arts = (out.searchResults || []).slice(0, 2);
      }
      q.articles = [...kb.slice(0, 1), ...arts];
    }

    const md = questions.length
      ? `I created a quiz on **${topicForSlack}** (10 questions).`
      : `I couldn't generate a quiz right now.`;
    await saveToHistory(sessionId, userMessage, md, { lastSearchQuery: query });
    return { text: md };
  }

  // Else: regular Slack explanation
  const history = await getConversationHistory(sessionId);
  const chat = startChat(history);
  const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases, topicForSlack);
  const prompt = `${header}

[QUERY]
${userMessage}

[SLACK OUTPUT]
Reply in Markdown. Provide a concise, accurate explanation drawn from the curriculum (no placeholders), then end with ONE short question to confirm understanding. If the request is out of scope, say so briefly and suggest 2–3 in-scope alternatives.`;
  const slackText = await runWithToolsIfNeeded(chat, prompt);
  await saveToHistory(sessionId, userMessage, slackText, { lastSearchQuery: query });
  return { text: slackText };
}

// -----------------------------------------------------------------------------
// API Endpoint
// -----------------------------------------------------------------------------
receiver.router.post('/api/chat', async (req, res) => {
  try {
    if (req.headers['x-api-key'] !== process.env.MY_LMS_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, userMessage, student_email, support_format } = req.body;
    if (!sessionId || !userMessage || !student_email) {
      return res.status(400).json({ error: 'sessionId, userMessage, and student_email are required.' });
    }

    const eventId = `api-${req.headers['x-request-id'] || uuidv4()}`;
    if (!await acquireEventLock(eventId)) {
      return res.status(429).json({ error: 'Duplicate request detected.' });
    }

    const result = await processUserRequest({
      sessionId,
      userMessage,
      studentEmail: student_email,
      supportFormat: support_format || null,
      responseMode: 'api'
    });

    return res.status(200).json(result.json);

  } catch (error) {
    const statusCode = /not active|not eligible|enrollment/i.test(error.message) ? 403 : 500;
    return res.status(statusCode).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// Slack handlers
// -----------------------------------------------------------------------------
async function handleSlackEvent({ event, client, say }) {
  try {
    if (!await acquireEventLock(event.event_ts || event.ts)) return;

    // More reliable email fetch + normalization
    let studentEmail;
    try {
      const info = await client.users.info({ user: event.user }); // preferred
      studentEmail = info?.user?.profile?.email;
    } catch (_) {}
    if (!studentEmail) {
      try {
        const prof = await client.users.profile.get({ user: event.user }); // fallback
        studentEmail = prof?.profile?.email;
      } catch (_) {}
    }
    studentEmail = normalizeEmail(studentEmail);

    if (!studentEmail) {
      await say({ text: "I couldn't find your email address in your Slack profile. Please add an email to your Slack profile or contact support.", thread_ts: event.thread_ts || event.ts });
      return;
    }

    const sessionId = `${event.channel}_${event.thread_ts || event.ts}`;
    const userMessage = (event.text || '').replace(/<@.*?>/g, '').trim();

    const { text } = await processUserRequest({
      sessionId,
      userMessage,
      studentEmail,
      supportFormat: null,
      responseMode: 'slack'
    });

    await say({ text, thread_ts: event.thread_ts || event.ts });

  } catch (error) {
    // Friendly message when Slack email isn’t enrolled
    const msg = String(error.message || '').includes('Could not verify student enrollment.')
      ? "Sorry, an error occurred: we can’t identify you as a student, kindly ensure you are signed into Slack with the same email address you used for your admission."
      : `Sorry, an error occurred: ${error.message}`;
    await say({ text: msg, thread_ts: event.thread_ts || event.ts });
  }
}

app.event('app_mention', handleSlackEvent);
app.message(async ({ message, say, client }) => {
  if (message.channel_type === 'im' && !message.bot_id && message.text) {
    await handleSlackEvent({ event: message, client, say });
  }
});

// For Cloud Functions / serverless
exports.slackBotHandler = receiver.app;
