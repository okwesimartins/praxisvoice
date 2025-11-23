const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();

// Basic health check so Cloud Run knows you’re alive
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

const server = http.createServer(app);

// WebSocket server on /ws
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  console.log("WS client connected", req.socket.remoteAddress);

  ws.send(JSON.stringify({ type: "welcome", msg: "connected to Cloud Run WS" }));

  ws.on("message", (data, isBinary) => {
    // Echo back whatever we got
    if (isBinary) {
      ws.send(data, { binary: true });
      return;
    }

    let msgText = data.toString();
    console.log("WS message:", msgText);

    ws.send(JSON.stringify({ type: "echo", msg: msgText }));
  });

  ws.on("close", () => console.log("WS client disconnected"));
  ws.on("error", (e) => console.error("WS error", e));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log("WebSocket service listening on", PORT);
});
