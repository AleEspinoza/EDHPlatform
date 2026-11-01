// Servidor HTTP + Socket.IO: salas privadas por código, reconexión por token.
import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { createRoom, addPlayer, removePlayer, applyAction, viewFor, log, GameError } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // salas sin actividad se eliminan a las 6 h
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 2e6 });

/** @type {Map<string, ReturnType<typeof createRoom>>} */
export const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcast(room) {
  for (const [, socket] of io.of('/').sockets) {
    if (socket.data.code === room.code) socket.emit('state', viewFor(room, socket.data.playerId));
  }
}

function seat(socket, room, player) {
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  player.connected = true;
}

const reply = (ack, payload) => typeof ack === 'function' && ack(payload);

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, solo } = {}, ack) => {
    const room = createRoom(newCode(), { solo: Boolean(solo) });
    rooms.set(room.code, room);
    const player = addPlayer(room, name);
    seat(socket, room, player);
    reply(ack, { ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name, token } = {}, ack) => {
    const room = rooms.get(String(code ?? '').toUpperCase().trim());
    if (!room) return reply(ack, { ok: false, error: 'No existe una sala con ese código' });
    try {
      let player = token && room.players.find((p) => p.token === token);
      if (player) log(room, `${player.name} se reconectó`);
      else if (room.solo) return reply(ack, { ok: false, error: 'Esa sala es una partida de práctica privada' });
      else player = addPlayer(room, name);
      seat(socket, room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(room);
    } catch (err) {
      reply(ack, { ok: false, error: err instanceof GameError ? err.message : 'Error al unirse' });
    }
  });

  socket.on('action', (action, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room) return reply(ack, { ok: false, error: 'No estás en una sala' });
    try {
      const result = applyAction(room, socket.data.playerId, action);
      reply(ack, { ok: true, private: result.private ?? null });
      if (result.event) io.to(room.code).emit('event', result.event);
      broadcast(room);
    } catch (err) {
      if (!(err instanceof GameError)) console.error(err);
      reply(ack, { ok: false, error: err instanceof GameError ? err.message : 'Error interno' });
    }
  });

  socket.on('leaveRoom', (_payload, ack) => {
    const room = rooms.get(socket.data.code);
    if (room) {
      removePlayer(room, socket.data.playerId);
      socket.leave(room.code);
      socket.data.code = null;
      if (room.solo || !room.players.some((p) => !p.controlledBy)) rooms.delete(room.code);
      else broadcast(room);
    }
    reply(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.playerId);
    const stillHere = [...io.of('/').sockets.values()].some(
      (s) => s.id !== socket.id && s.data.code === room.code && s.data.playerId === socket.data.playerId,
    );
    if (player && !stillHere) {
      player.connected = false;
      broadcast(room);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL_MS && !room.players.some((p) => p.connected && !p.controlledBy)) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  httpServer.listen(PORT, () => console.log(`EDH Platform escuchando en http://localhost:${PORT}`));
}

export { httpServer };
