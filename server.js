// server.js — Praxis Voice Backend (Gemini + Google TTS + WebSocket)
const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");
const { getEventsForStudent, getEventsByCalendarId, addStudentsToEvent, removeEventFromCalendar } = require("./googleCalendar"); // Importing the functions

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
// Extract meeting link
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

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

// Endpoint to get all events by calendar ID
app.get("/calendar-events", async (req, res) => {
  try {
    const { calendarId } = req.query;

    // simple API key protection
    if (req.headers["x-api-key"] !== process.env.MY_LMS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!calendarId) {
      return res
        .status(400)
        .json({ error: "Missing required query param: calendarId" });
    }

    const events = await getEventsByCalendarId(calendarId);

    return res.json({ events });
  } catch (err) {
    console.error("/calendar-events error:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch events", details: err.message });
  }
});

// Endpoint to add multiple students to an event
app.post("/add-students-to-event", async (req, res) => {
  try {
    const { calendarId, eventId, emails } = req.body;

    if (req.headers["x-api-key"] !== process.env.MY_LMS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!calendarId || !eventId || !emails || !emails.length) {
      return res.status(400).json({
        error: "Missing required fields: calendarId, eventId, or emails",
      });
    }

    const result = await addStudentsToEvent(calendarId, eventId, emails);
    return res.json({ success: true, event: result });
  } catch (err) {
    console.error("/add-students-to-event error:", err);
    return res
      .status(500)
      .json({ error: "Failed to add students to event", details: err.message });
  }
});

// Endpoint to remove an event from the calendar
app.delete("/remove-event", async (req, res) => {
  try {
    const { calendarId, eventId } = req.body;

    if (req.headers["x-api-key"] !== process.env.MY_LMS_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!calendarId || !eventId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await removeEventFromCalendar(calendarId, eventId);
    return res.json(result);
  } catch (err) {
    console.error("/remove-event error:", err);
    return res
      .status(500)
      .json({ error: "Failed to remove event", details: err.message });
  }
});

// -----------------------------------------------------------------------------
// WebSocket /ws — voice UI chat
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

        const header = buildContextHeader(studentEmail, enrolledCourseNames, allowedPhrases);
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
          apiVersion: GEMINI_API_VERSION,
        };
        if (tts && tts.audioBase64) {
          payload.audio = tts.audioBase64;
          payload.audioMime = tts.mimeType;
        }

        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error(`[WS ${ws.id}] Gemini error:`, err);

        ws.send(
          JSON.stringify({
            type: "error",
            error: err.message || "Gemini error",
            details: {
              model: getCurrentModelLabel(),
              apiVersion: GEMINI_API_VERSION,
              ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
            },
          })
        );
      }
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
  resolveActiveModel()
    .then((m) => console.log(`✅ Gemini model resolved: ${m}`))
    .catch((e) =>
      console.warn(`⚠️ Gemini model resolve failed after listen: ${e.message || e}`)
    );
});
