/**
 * Cloud Run SERVICE entrypoint for voice.
 * - Uses your existing Praxis app from index.js
 * - Adds /ws/voice to bridge browser audio <-> Gemini Live
 */

// const http = require("http");
// const WebSocket = require("ws");
// const { v4: uuidv4 } = require("uuid");

// const praxis = require("./index.js");

// const {
//   receiverApp,
//   getStudentScope,
//   buildContextHeader,
//   BASE_SYSTEM_INSTRUCTION,
//   toolDefs,
//   availableTools,
//   normalizeEmail,
// } = praxis;

// const GEMINI_LIVE_WS =
//   "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// const LIVE_MODEL =
//   process.env.GEMINI_LIVE_MODEL ||
//   "gemini-2.5-flash-native-audio-preview-09-2025";

// function openGeminiLiveSocket({ systemInstruction, tools }) {
//   const apiKey = process.env.GEMINI_API_KEY;
//   if (!apiKey) throw new Error("GEMINI_API_KEY missing in env.");

//   const ws = new WebSocket(`${GEMINI_LIVE_WS}?key=${encodeURIComponent(apiKey)}`);

//   ws.on("open", () => {
//     ws.send(JSON.stringify({
//       setup: {
//         model: LIVE_MODEL,
//         generationConfig: {
//           responseModalities: ["AUDIO", "TEXT"],
//           temperature: 0.4,
//           maxOutputTokens: 512,
//         },
//         systemInstruction,
//         tools,
//       }
//     }));
//   });

//   return ws;
// }

// const server = http.createServer(receiverApp);
// const wss = new WebSocket.Server({ server, path: "/ws/voice" });

// wss.on("connection", (clientWs) => {
//   let geminiWs = null;
//   let sessionId = uuidv4();

//   const sendClient = (obj) => {
//     if (clientWs.readyState === WebSocket.OPEN) {
//       clientWs.send(JSON.stringify(obj));
//     }
//   };

//   clientWs.on("message", async (raw) => {
//     let msg;
//     try { msg = JSON.parse(raw.toString()); }
//     catch { return; }

//     // START
//     if (msg.type === "start") {
//       try {
//         sessionId = msg.sessionId || sessionId;
//         const studentEmail = normalizeEmail(msg.student_email);

//         // optional LMS key auth
//         if (msg.lmsKey && msg.lmsKey !== process.env.MY_LMS_API_KEY) {
//           sendClient({ type: "error", error: "Unauthorized client" });
//           clientWs.close();
//           return;
//         }

//         const scope = await getStudentScope(studentEmail);
//         const enrolledCourseNames = scope.courseNames.join(", ");
//         const allowedPhrases = scope.allowedPhrases;

//         const header = buildContextHeader(
//           studentEmail,
//           enrolledCourseNames,
//           allowedPhrases,
//           "(live voice session)"
//         );

//         const systemInstruction =
//           `${BASE_SYSTEM_INSTRUCTION}\n\n${header}`;

//         geminiWs = openGeminiLiveSocket({
//           systemInstruction,
//           tools: toolDefs, // keeps your tools working in voice
//         });

//         geminiWs.on("message", async (data) => {
//           let gm;
//           try { gm = JSON.parse(data.toString()); }
//           catch { return; }

//           if (gm.setupComplete) {
//             sendClient({ type: "ready", sessionId });
//           }

//           const parts = gm?.serverContent?.modelTurn?.parts || [];
//           for (const p of parts) {
//             if (p.inlineData?.mimeType?.startsWith("audio/pcm")) {
//               sendClient({ type: "audio", data: p.inlineData.data });
//             }
//             if (p.text) {
//               sendClient({ type: "text", text: p.text });
//             }
//           }

//           // tool calling
//           if (gm.toolCall?.functionCalls?.length) {
//             const functionResponses = [];
//             for (const fc of gm.toolCall.functionCalls) {
//               const fn = availableTools[fc.name];
//               if (!fn) continue;
//               const toolResult = await fn(fc.args || {});
//               functionResponses.push({
//                 id: fc.id,
//                 name: fc.name,
//                 response: {
//                   name: fc.name,
//                   content: [{ text: JSON.stringify(toolResult) }],
//                 },
//               });
//             }
//             if (functionResponses.length) {
//               geminiWs.send(JSON.stringify({ toolResponse: { functionResponses } }));
//             }
//           }

//           if (gm?.serverContent?.turnComplete) {
//             sendClient({ type: "turnComplete" });
//           }
//         });

//         geminiWs.on("close", (code, reason) => {
//           sendClient({ type: "error", error: `Gemini WS closed: ${code} ${reason || ""}` });
//           clientWs.close();
//         });

//         geminiWs.on("error", (e) => {
//           sendClient({ type: "error", error: e.message || "Gemini WS error" });
//         });

//       } catch (e) {
//         sendClient({ type: "error", error: e.message });
//       }
//       return;
//     }

//     if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;

//     // AUDIO IN (PCM16k base64)
//     if (msg.type === "audio") {
//       geminiWs.send(JSON.stringify({
//         realtimeInput: {
//           audio: {
//             mimeType: "audio/pcm;rate=16000",
//             data: msg.data
//           }
//         }
//       }));
//       return;
//     }

//     // optional TEXT IN
//     if (msg.type === "text") {
//       geminiWs.send(JSON.stringify({
//         realtimeInput: { text: msg.text || "" }
//       }));
//       return;
//     }

//     // STOP
//     if (msg.type === "stop") {
//       geminiWs.send(JSON.stringify({
//         realtimeInput: { audioStreamEnd: true }
//       }));
//       return;
//     }
//   });

//   clientWs.on("close", () => {
//     if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
//   });
// });

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`Praxis Voice Service listening on ${PORT}`);
});
