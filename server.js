// server/server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const questionsPath = path.join(__dirname, "questions.json");
const questionsData = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(process.cwd(), "web", "dist")));
app.use("/images", express.static(path.join(__dirname, "images")));

const games = {}; // games[room] = { hostId, players, round, buzzer }

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function publicPlayers(room) {
  const g = games[room];
  if (!g) return [];
  return Object.entries(g.players)
    .filter(([_, p]) => p.role === "player")
    .map(([sid, p]) => ({ sid, name: p.name, score: p.score }));
}

function normalizeAnswer(answer, round) {
  if (typeof answer === "number") {
    if (Array.isArray(round?.choices) && round.choices[answer] != null)
      return String(round.choices[answer]);
    return String(answer);
  }
  return String(answer ?? "");
}

function callCb(cb, payload) {
  if (typeof cb === "function") cb(payload);
}

io.on("connection", (socket) => {
  console.log("socket", socket.id);

  // Create room
  socket.on("createRoom", (cb) => {
    const room = makeRoomCode();
    games[room] = { hostId: socket.id, players: {}, round: null, buzzer: null };
    socket.join(room);
    socket.data.room = room;
    socket.data.role = "host";
    callCb(cb, { ok: true, room });
    io.to(room).emit("players", publicPlayers(room));
  });

  // Join room
  socket.on("joinRoom", ({ room, name, role } = {}, cb) => {
    const g = games[room];
    if (!g) return callCb(cb, { ok: false, error: "Room not found" });

    socket.join(room);
    socket.data.room = room;
    socket.data.role = role || "player";
    g.players[socket.id] = {
      name,
      score: g.players[socket.id]?.score || 0,
      role: socket.data.role,
      buzzerLocked: false, // For buzzer rounds
    };

    io.to(room).emit("players", publicPlayers(room));
    callCb(cb, { ok: true });
  });

  // Start round
  socket.on("startRound", ({ roundType, duration } = {}, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host")
      return callCb(cb, { ok: false, error: "Not host or no game" });

    const now = Date.now();
    const durMs = (duration || 15) * 1000;

    g.round = {
      type: roundType,
      questionIndex: 0,
      roundScores: g.round?.roundScores || {},
      startedAt: now,
      endsAt: now + durMs,
      buzzerLocked: false,
      buzzer: null,
    };

    io.to(room).emit("roundStarted", { round: g.round });
    callCb(cb, { ok: true });
  });

  // Start question
  socket.on("startQuestion", ({ question } = {}, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host" || !g.round)
      return callCb(cb, { ok: false });

    // Clear any previous ticker
    if (g.round._questionTick) {
      clearInterval(g.round._questionTick);
      g.round._questionTick = null;
    }

    if (question.type === "buzzer") {
      startBuzzerQuestion(g, question);
    } else if (question.type === "sequence" || question.type === "links") {
      startSequenceQuestion(g, question);
    } else {
      startMCQuestion(g, question);
    }

    callCb(cb, { ok: true });
  });

  function startMCQuestion(g, question) {
    const r = g.round;

    r.currentQuestion = question;
    r.answers = {};
    r.currentQuestionScores = {};
    r.correctAnswer = question.answer;
    r.choices = question.choices || null;
    r.buzzer = null;
    r.buzzerLocked = false;
    r.allAnswered = false;
    r.endsAt = Date.now() + 30_000;

    io.to(g.hostId).emit("hostQuestionData", {
      ...question,
      index: r.questionIndex,
    });

    io.to(Object.keys(g.players)).emit("questionStarted", {
      question: { ...question, index: r.questionIndex },
      endsAt: r.endsAt,
      roundTotals: { ...r.roundScores },
    });

    // Start ticker
    if (r._questionTick) clearInterval(r._questionTick);
    r._questionTick = setInterval(() => {
      const remaining = Math.max(0, Math.round((r.endsAt - Date.now()) / 1000));
      io.to(Object.keys(g.players)).emit("tick", { remaining });

      if (remaining <= 0) {
        clearInterval(r._questionTick);
        r._questionTick = null;
        io.to(Object.keys(g.players)).emit("roundEnded", { reason: "timeUp" });
      }
    }, 500);
  }

  function startBuzzerQuestion(g, question) {
    const r = g.round;
    const room = socket.data.room;

    r.currentQuestion = question;
    r.answers = {};
    r.currentQuestionScores = {};
    r.correctAnswer = question.answer;
    r.choices = null;
    r.buzzer = null;
    r.buzzerLocked = false;
    r.lastBuzzed = null;
    r.allAnswered = false;
    r.endsAt = null;

    Object.values(g.players).forEach((p) => (p.buzzerLocked = false));

    io.to(room).emit("buzzerReset");

    // Broadcast to all players (no endsAt)
    io.to(Object.keys(g.players)).emit("questionStarted", {
      question: { ...question, index: r.questionIndex },
      endsAt: null,
      roundTotals: { ...r.roundScores },
    });

    // Send correct answer only to host
    io.to(g.hostId).emit("hostBuzzerQuestionStarted", {
      question: {
        ...question,
        index: r.questionIndex,
        correctAnswer: question.answer,
      },
      roundTotals: { ...r.roundScores },
    });
  }

  function startSequenceQuestion(g, question) {
    const r = g.round;
    const room = socket.data.room;

    r.currentQuestion = question;
    r.answers = {};
    r.currentQuestionScores = {};
    r.correctAnswer = question.answer;
    r.revealedStepIndex = 0;
    r.allAnswered = false;
    r.endsAt = null;
    r.buzzer = null;
    r.lastBuzzed = null;

    // Reset per-player buzzer locks
    Object.values(g.players).forEach((p) => (p.buzzerLocked = false));

    // --- PLAYER/PRESENTER VIEW ---
    io.to(room).emit("sequenceStarted", {
      question: { ...question, index: r.questionIndex },
      visibleSteps: [question.steps[0]],
      revealedStepIndex: 0,
      roundTotals: { ...r.roundScores },
    });

    // --- HOST VIEW ---
    io.to(g.hostId).emit("hostSequenceQuestionStarted", {
      question: { ...question, index: r.questionIndex },
      steps: question.steps,
      correctAnswer: question.answer,
      points: question.points || [50, 30, 20, 10],
    });
  }

  // Player buzz
  socket.on("buzz", (cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || !g.round) return callCb(cb, { ok: false, error: "No round" });

    const r = g.round;

    if (r.buzzerLocked)
      return callCb(cb, { ok: false, error: "Buzzers locked" });

    const player = g.players[socket.id];
    if (!player || player.buzzerLocked)
      return callCb(cb, { ok: false, error: "You are locked out" });

    if (r.buzzer) return callCb(cb, { ok: false, error: "Already buzzed" });

    r.buzzer = { sid: socket.id, name: player.name, ts: Date.now() };

    // <---- ADD THIS LINE ---->
    r.lastBuzzed = socket.id;

    io.to(room).emit("buzzed", r.buzzer);

    callCb(cb, { ok: true, buzzer: r.buzzer });
  });

  socket.on("resetBuzzer", ({ all = true, preserveLocks = false } = {}, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host") return callCb(cb, { ok: false });

    const r = g.round;
    if (!r) return callCb(cb, { ok: false });

    // --- MODE 1: Full reset (existing behaviour) ---
    if (all && !preserveLocks) {
      r.buzzer = null;
      r.lastBuzzed = null;
      r.buzzerLocked = false;

      Object.values(g.players).forEach((p) => {
        p.buzzerLocked = false;
        io.to(p.sid).emit("buzzerStatus", { disabled: false });
      });

      // --- MODE 3: Reset but preserve existing lockouts ---
    } else if (!all && preserveLocks) {
      r.buzzer = null;
      r.lastBuzzed = null;

      // Do NOT change any player's buzzerLocked state,
      // just tell clients their current state again for UI correctness.
      Object.values(g.players).forEach((p) => {
        io.to(p.sid).emit("buzzerStatus", { disabled: p.buzzerLocked });
      });

      // --- MODE 2: Reset except last buzzed (existing behaviour) ---
    } else {
      const lastSid = r.lastBuzzed;
      if (lastSid && g.players[lastSid]) {
        g.players[lastSid].buzzerLocked = true;

        io.to(lastSid).emit("buzzerStatus", { disabled: true });
        io.to(room).emit("buzzerLockedOut", { sid: lastSid });
      }

      r.buzzer = null;
      r.lastBuzzed = null;
    }

    io.to(room).emit("buzzerReset");
    callCb(cb, { ok: true });
  });

  // Submit answer
  socket.on("submitAnswer", ({ answer }, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || !g.round) return callCb(cb, { ok: false });

    const r = g.round;

    const now = Date.now();
    // If endsAt exists and now > endsAt, it's too late
    if (r.endsAt && now > r.endsAt) {
      return callCb(cb, { ok: false, reason: "tooLate" });
    }

    // Record answer (store raw answer)
    r.answers[socket.id] = answer;

    // Compute correctness for preview
    try {
      const isCorrect =
        normalizeAnswer(answer, r).trim().toLowerCase() ===
        normalizeAnswer(r.correctAnswer, r).trim().toLowerCase();
      r.currentQuestionScores[socket.id] = isCorrect ? 10 : 0;
    } catch (e) {
      r.currentQuestionScores[socket.id] = 0;
    }

    // Check if all players answered (only role === 'player')
    const allPlayersAnswered = Object.keys(g.players)
      .filter((sid) => g.players[sid].role === "player")
      .every((sid) => r.answers[sid] !== undefined);

    if (allPlayersAnswered) {
      r.allAnswered = true; // <--- NEW: persist server-side
      if (r._questionTick) {
        clearInterval(r._questionTick);
        r._questionTick = null;
      }

      io.to(room).emit("allAnswered", {
        answerCount: Object.keys(r.answers).length,
      });
    }

    // Also notify presenter/clients that this player answered
    io.to(room).emit("playerAnswered", {
      id: socket.id,
      name: g.players[socket.id]?.name,
    });

    callCb(cb, { ok: true });
  });

  // Reveal answer
  // Reveal answer — compute preview scores for the current question only (DO NOT mutate roundScores/global here)
  socket.on("revealAnswer", (_, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host" || !g.round)
      return callCb(cb, { ok: false });

    const r = g.round;

    const allAnswered = !!r.allAnswered;
    const timeExpired = (r.endsAt || 0) <= Date.now();

    const isBuzzer = r.currentQuestion?.buzzer;
    if (!allAnswered && !isBuzzer && !timeExpired) {
      return callCb(cb, { ok: false, reason: "early" });
    }

    io.to(room).emit("answerRevealed", {
      answer: r.correctAnswer,
      defaultQuestionScores: { ...r.currentQuestionScores },
      roundTotals: { ...r.roundScores },
      questionIndex: r.questionIndex,
    });

    callCb(cb, { ok: true });
  });

  // Confirm points
  socket.on("confirmPoints", (confirmedScores = {}, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || !g.round || socket.data.role !== "host")
      return callCb(cb, { ok: false });

    const r = g.round;
    Object.entries(confirmedScores).forEach(([sid, ptsRaw]) => {
      const pts = Number(ptsRaw || 0);
      r.roundScores[sid] = (r.roundScores[sid] || 0) + pts;
      if (g.players[sid])
        g.players[sid].score = (g.players[sid].score || 0) + pts;
    });

    r.questionIndex = (r.questionIndex || 0) + 1;
    r.currentQuestion = null;
    r.currentQuestionScores = {};
    r.answers = {};
    r.buzzer = null;
    r.buzzerLocked = false;

    io.to(room).emit("scoreUpdate", publicPlayers(room));
    callCb(cb, { ok: true });
  });

  // End round
  socket.on("endRound", (data, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host") return callCb(cb, { ok: false });

    io.to(room).emit("roundScoresFinal", {
      roundScores: { ...g.round.roundScores },
    });

    const leaderboard = Object.entries(g.players)
      .filter(([_, p]) => p.role === "player")
      .map(([sid, p]) => ({
        sid,
        name: p.name,
        score: g.round.roundScores[sid] || 0,
      }));

    io.to(room).emit("roundLeaderboard", {
      roundScores: g.round.roundScores,
      players: leaderboard,
    });

    if (g.round._questionTick) clearInterval(g.round._questionTick);
    g.round = null;
    g.buzzer = null;
    callCb(cb, { ok: true });
  });

  // Show full leaderboard
  socket.on("showFullLeaderboard", (_, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host") return callCb(cb, { ok: false });

    io.to(room).emit("finalScoreboard", { players: publicPlayers(room) });
    callCb(cb, { ok: true });
  });

  // End show
  socket.on("endShow", (_, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host") return callCb(cb, { ok: false });

    io.to(room).emit("finalScoreboard", { players: publicPlayers(room) });
    callCb(cb, { ok: true });
  });

  // Get questions
  socket.on("getQuestions", ({ type, count } = {}, cb) => {
    try {
      if (!type || !questionsData[type])
        return callCb(cb, { ok: false, error: "Invalid type" });

      let filtered = questionsData[type]
        .sort(() => 0.5 - Math.random())
        .slice(0, count);
      const questionsWithType = filtered.map((q) => ({ type, ...q }));
      callCb(cb, { ok: true, questions: questionsWithType });
    } catch (err) {
      console.error(err);
      callCb(cb, { ok: false, error: "Failed to load questions" });
    }
  });

  socket.on("revealNextStep", (_, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host" || !g.round)
      return callCb(cb, { ok: false });

    const r = g.round;
    const q = r.currentQuestion;
    if (!q || !q.steps) return callCb(cb, { ok: false });

    // If already at last visible step, block (host can call final reveal instead)
    if (r.revealedStepIndex >= q.steps.length - 1) {
      return callCb(cb, { ok: false, reason: "noMoreSteps" });
    }

    r.revealedStepIndex++;

    // Notify players/presenter of the newly revealed step
    io.to(room).emit("sequenceStepRevealed", {
      index: r.revealedStepIndex,
      step: q.steps[r.revealedStepIndex],
      visibleSteps: q.steps.slice(0, r.revealedStepIndex + 1),
    });

    callCb(cb, { ok: true, revealedStepIndex: r.revealedStepIndex });
  });

  socket.on("revealSequenceAnswer", (_, cb) => {
    const room = socket.data.room;
    const g = games[room];
    if (!g || socket.data.role !== "host" || !g.round)
      return callCb(cb, { ok: false });

    const r = g.round;
    const q = r.currentQuestion;
    if (!q) return callCb(cb, { ok: false });

    // Mark round state so UI can show scoring interface
    r.state = "answerRevealed";

    // Broadcast full sequence + answer to all players
    io.to(room).emit("sequenceAnswerRevealed", {
      title: q.title,
      steps: q.steps, // all revealed steps
      answer: q.answer, // final answer
      questionIndex: r.questionIndex,
    });

    callCb(cb, { ok: true });
  });

  // Disconnect
  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room) return;
    const g = games[room];
    if (!g) return;

    if (socket.data.role === "host") {
      io.to(room).emit("hostLeft");
      delete games[room];
    } else {
      delete g.players[socket.id];
      io.to(room).emit("players", publicPlayers(room));
    }
  });
});

server.listen(3000, () => console.log("Server running on :3000"));
