// Historial de partidas y estadísticas por cuenta.

export function createHistory(db) {
  const q = {
    insertGame: db.prepare('INSERT INTO games (room_code, started_at, ended_at, turns, result, winner_name) VALUES (?, ?, ?, ?, ?, ?)'),
    insertPlayer: db.prepare('INSERT INTO game_players (game_id, user_id, seat, name, commanders, is_winner, final_life) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    gamesForUser: db.prepare(`SELECT g.* FROM games g JOIN game_players me ON me.game_id = g.id
                              WHERE me.user_id = ? ORDER BY g.ended_at DESC LIMIT ? OFFSET ?`),
    playersOf: db.prepare('SELECT user_id, seat, name, commanders, is_winner, final_life FROM game_players WHERE game_id = ? ORDER BY seat'),
    totals: db.prepare(`SELECT COUNT(*) AS games,
                               SUM(CASE WHEN me.is_winner = 1 THEN 1 ELSE 0 END) AS wins,
                               SUM(CASE WHEN g.result = 'win' AND me.is_winner = 0 THEN 1 ELSE 0 END) AS losses,
                               SUM(CASE WHEN g.result = 'draw' THEN 1 ELSE 0 END) AS draws,
                               SUM(CASE WHEN g.result = 'unfinished' THEN 1 ELSE 0 END) AS unfinished,
                               AVG(CASE WHEN g.result != 'unfinished' THEN g.turns END) AS avg_turns,
                               AVG(CASE WHEN g.result != 'unfinished' THEN g.ended_at - g.started_at END) AS avg_ms
                        FROM games g JOIN game_players me ON me.game_id = g.id WHERE me.user_id = ?`),
    byCommander: db.prepare(`SELECT me.commanders AS commanders, COUNT(*) AS games,
                                    SUM(me.is_winner) AS wins, MAX(g.ended_at) AS last_played
                             FROM games g JOIN game_players me ON me.game_id = g.id
                             WHERE me.user_id = ? AND g.result != 'unfinished' AND me.commanders != ''
                             GROUP BY me.commanders ORDER BY games DESC, wins DESC LIMIT 20`),
  };

  return {
    /** Guarda una partida; ignora las de práctica y las que no tienen jugadores con cuenta. */
    record(rec) {
      if (rec.solo || !rec.players.some((pl) => pl.userId)) return null;
      const { lastInsertRowid } = q.insertGame.run(rec.roomCode, rec.startedAt, rec.endedAt, rec.turns, rec.result, rec.winnerName);
      const gameId = Number(lastInsertRowid);
      for (const pl of rec.players) {
        q.insertPlayer.run(gameId, pl.userId ?? null, pl.seat, pl.name, pl.commanders, pl.isWinner ? 1 : 0, pl.life ?? null);
      }
      return gameId;
    },

    games(userId, { limit = 30, offset = 0 } = {}) {
      return q.gamesForUser.all(userId, Math.min(100, limit), Math.max(0, offset)).map((g) => {
        const players = q.playersOf.all(g.id);
        const me = players.find((pl) => pl.user_id === userId);
        return {
          id: g.id,
          startedAt: g.started_at,
          endedAt: g.ended_at,
          turns: g.turns,
          result: g.result === 'win' ? (me?.is_winner ? 'win' : 'loss') : g.result,
          winnerName: g.winner_name,
          myCommanders: me?.commanders ?? '',
          players: players.map((pl) => ({ name: pl.name, commanders: pl.commanders, isWinner: Boolean(pl.is_winner), isMe: pl.user_id === userId, life: pl.final_life })),
        };
      });
    },

    stats(userId) {
      const t = q.totals.get(userId);
      const decided = (t.wins ?? 0) + (t.losses ?? 0);
      return {
        games: t.games ?? 0,
        wins: t.wins ?? 0,
        losses: t.losses ?? 0,
        draws: t.draws ?? 0,
        unfinished: t.unfinished ?? 0,
        winRate: decided ? (t.wins ?? 0) / decided : null,
        avgTurns: t.avg_turns ? Math.round(t.avg_turns * 10) / 10 : null,
        avgMinutes: t.avg_ms != null ? Math.max(1, Math.round(t.avg_ms / 60000)) : null,
        byCommander: q.byCommander.all(userId).map((r) => ({ commanders: r.commanders, games: r.games, wins: r.wins, lastPlayed: r.last_played })),
      };
    },
  };
}
