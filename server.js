const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/ttt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ttt', 'index.html'));
});

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  return hand.sort((a, b) => {
    const rankDiff = RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
    if (rankDiff !== 0) return rankDiff;
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

function getValidRanks(topCardRank) {
  const idx = RANKS.indexOf(topCardRank);
  const lower = (idx - 1 + 13) % 13;
  const upper = (idx + 1) % 13;
  const valid = new Set([RANKS[lower], RANKS[idx], RANKS[upper]]);
  return [...valid];
}

function isValidDeclaredRank(topCardRank, declaredRank) {
  return getValidRanks(topCardRank).includes(declaredRank);
}

function isCardMatchingDeclaredRank(card, declaredRank) {
  return card.rank === declaredRank;
}

function getPlayerView(room, socketId) {
  const gs = room.gameState;
  const playerIndex = room.players.findIndex(p => p.id === socketId);

  // Build opponents list (everyone except this player)
  const opponents = room.players
    .filter((_, i) => i !== playerIndex)
    .map(p => ({
      name: p.name,
      cardCount: (gs.hands[p.id] || []).length
    }));

  // During CHALLENGE, valid ranks are based on declared rank (it will become new top)
  const validRanks = (gs.phase === 'CHALLENGE' && gs.lastPlay)
    ? getValidRanks(gs.lastPlay.declaredRank)
    : (gs.visibleTopRank ? getValidRanks(gs.visibleTopRank) : []);

  // Who played last (for challenge info)
  let lastPlayerName = null;
  if (gs.lastPlay !== null) {
    lastPlayerName = room.players[gs.lastPlay.playerIndex].name;
  }

  return {
    hand: gs.hands[socketId] || [],
    opponents,
    pileSize: gs.pile.length,
    bankSize: gs.bank.length,
    topRank: gs.visibleTopRank,
    topCard: gs.visibleTopCard,
    validRanks,
    isYourTurn: gs.currentPlayerIndex === playerIndex,
    phase: gs.phase,
    declaredRank: gs.lastPlay ? gs.lastPlay.declaredRank : null,
    lastPlayerName,
    currentPlayerName: room.players[gs.currentPlayerIndex].name,
    yourName: room.players[playerIndex].name
  };
}

function emitGameState(room) {
  for (const player of room.players) {
    io.to(player.id).emit('game-state', getPlayerView(room, player.id));
  }
}

function refillBank(room) {
  const gs = room.gameState;
  if (gs.bank.length > 0) return;
  if (gs.pile.length <= 1) return;
  const topCard = gs.pile.pop();
  gs.bank = shuffle([...gs.pile]);
  gs.pile = [topCard];
}

function startGame(room) {
  const deck = createDeck();
  const numPlayers = room.players.length;

  // Deal 8 cards each
  const hands = {};
  for (let i = 0; i < numPlayers; i++) {
    hands[room.players[i].id] = sortHand(deck.splice(0, 8));
  }

  // Draw one card from remaining deck as the starting top card (face-up)
  const startingCard = deck.splice(0, 1)[0];

  room.gameState = {
    hands,
    pile: [startingCard],
    bank: deck,
    visibleTopRank: startingCard.rank,
    visibleTopCard: startingCard,
    currentPlayerIndex: Math.floor(Math.random() * numPlayers),
    phase: 'PLAY',
    lastPlay: null
  };

  emitGameState(room);
}

function advanceTurn(room) {
  const gs = room.gameState;
  const numPlayers = room.players.length;
  gs.currentPlayerIndex = (gs.currentPlayerIndex + 1) % numPlayers;
  gs.phase = 'PLAY';
  gs.lastPlay = null;
}

function checkWin(room) {
  const gs = room.gameState;
  for (let i = 0; i < room.players.length; i++) {
    const playerId = room.players[i].id;
    if (gs.hands[playerId].length === 0) {
      return i;
    }
  }
  return null;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name, maxPlayers }) => {
    const mp = Math.min(8, Math.max(2, parseInt(maxPlayers) || 2));
    const code = generateRoomCode();
    const room = {
      code,
      maxPlayers: mp,
      players: [{ id: socket.id, name: name || 'Player 1' }],
      gameState: null
    };
    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    socket.emit('room-created', { code, maxPlayers: mp });
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error-msg', { message: 'Room not found.' });
      return;
    }

    // Check for reconnection
    if (room.players.length >= room.maxPlayers) {
      const disconnectedIdx = room.players.findIndex(p => !io.sockets.sockets.get(p.id));
      if (disconnectedIdx === -1) {
        socket.emit('error-msg', { message: 'Room is full.' });
        return;
      }

      const oldId = room.players[disconnectedIdx].id;
      room.players[disconnectedIdx].id = socket.id;
      room.players[disconnectedIdx].name = name || room.players[disconnectedIdx].name;
      currentRoom = code;
      socket.join(code);

      if (room.gameState && room.gameState.hands[oldId]) {
        room.gameState.hands[socket.id] = room.gameState.hands[oldId];
        delete room.gameState.hands[oldId];
      }

      // Notify all players
      for (const p of room.players) {
        io.to(p.id).emit('room-update', {
          players: room.players.map(pl => pl.name),
          maxPlayers: room.maxPlayers
        });
      }

      if (room.gameState) {
        emitGameState(room);
      }
      return;
    }

    room.players.push({ id: socket.id, name: name || ('Player ' + (room.players.length + 1)) });
    currentRoom = code;
    socket.join(code);

    // Notify all players of lobby update
    for (const p of room.players) {
      io.to(p.id).emit('room-update', {
        players: room.players.map(pl => pl.name),
        maxPlayers: room.maxPlayers
      });
    }

    // Start game when room is full
    if (room.players.length === room.maxPlayers) {
      startGame(room);
    }
  });

  socket.on('play-card', ({ cardIndex, declaredRank }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);

    const isCurrentPlayer = gs.currentPlayerIndex === playerIndex;

    if (gs.phase === 'PLAY' && !isCurrentPlayer) return;
    if (gs.phase === 'CHALLENGE' && playerIndex === gs.lastPlay.playerIndex) return;
    if (gs.phase === 'GAME_OVER') return;

    // During CHALLENGE, the current player can play (implicit pass)
    if (gs.phase === 'CHALLENGE' && playerIndex !== gs.lastPlay.playerIndex) {
      if (!isCurrentPlayer) return;

      // Accept the previous play (implicit pass)
      gs.visibleTopRank = gs.lastPlay.declaredRank;
      gs.visibleTopCard = null;

      const winner = checkWin(room);
      if (winner !== null) {
        gs.phase = 'GAME_OVER';
        for (const p of room.players) {
          io.to(p.id).emit('game-over', { won: room.players.indexOf(p) === winner, winnerName: room.players[winner].name });
        }
        emitGameState(room);
        return;
      }

      refillBank(room);
      gs.currentPlayerIndex = playerIndex;
      gs.lastPlay = null;
    }

    const hand = gs.hands[socket.id];
    if (cardIndex < 0 || cardIndex >= hand.length) return;

    if (!isValidDeclaredRank(gs.visibleTopRank, declaredRank)) return;

    const playedCard = hand.splice(cardIndex, 1)[0];
    gs.pile.push(playedCard);

    gs.lastPlay = {
      card: playedCard,
      declaredRank,
      playerIndex
    };

    // Next player in line responds to the challenge
    gs.currentPlayerIndex = (playerIndex + 1) % room.players.length;
    gs.phase = 'CHALLENGE';
    emitGameState(room);
  });

  socket.on('call-cheat', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const isCurrentPlayer = gs.currentPlayerIndex === playerIndex;

    if (gs.phase !== 'CHALLENGE') return;
    if (playerIndex === gs.lastPlay.playerIndex) return;
    if (!isCurrentPlayer) return;
    if (!gs.lastPlay) return;

    const wasCheating = !isCardMatchingDeclaredRank(gs.lastPlay.card, gs.lastPlay.declaredRank);

    let loserId;
    if (wasCheating) {
      loserId = room.players[gs.lastPlay.playerIndex].id;
    } else {
      loserId = socket.id;
    }

    gs.hands[loserId].push(...gs.pile);
    sortHand(gs.hands[loserId]);
    gs.pile = [];

    if (gs.bank.length > 0) {
      const newTopCard = gs.bank.pop();
      gs.pile.push(newTopCard);
      gs.visibleTopRank = newTopCard.rank;
      gs.visibleTopCard = newTopCard;
    }

    const challengerName = room.players[playerIndex].name;
    const playedByName = room.players[gs.lastPlay.playerIndex].name;

    for (const player of room.players) {
      io.to(player.id).emit('challenge-result', {
        wasCheating,
        revealedCard: gs.lastPlay.card,
        declaredRank: gs.lastPlay.declaredRank,
        message: wasCheating
          ? `Caught cheating! ${playedByName} picks up the pile.`
          : `Not cheating! ${challengerName} picks up the pile.`
      });
    }

    advanceTurn(room);

    const winner = checkWin(room);
    if (winner !== null) {
      gs.phase = 'GAME_OVER';
      for (const p of room.players) {
        io.to(p.id).emit('game-over', { won: room.players.indexOf(p) === winner, winnerName: room.players[winner].name });
      }
    }

    emitGameState(room);
  });

  socket.on('draw-card', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const isCurrentPlayer = gs.currentPlayerIndex === playerIndex;

    if (gs.phase === 'PLAY' && !isCurrentPlayer) return;
    if (gs.phase === 'CHALLENGE' && playerIndex === gs.lastPlay.playerIndex) return;
    if (gs.phase === 'GAME_OVER') return;

    if (gs.phase === 'CHALLENGE' && playerIndex !== gs.lastPlay.playerIndex) {
      if (!isCurrentPlayer) return;

      gs.visibleTopRank = gs.lastPlay.declaredRank;
      gs.visibleTopCard = null;

      const winner = checkWin(room);
      if (winner !== null) {
        gs.phase = 'GAME_OVER';
        for (const p of room.players) {
          io.to(p.id).emit('game-over', { won: room.players.indexOf(p) === winner, winnerName: room.players[winner].name });
        }
        emitGameState(room);
        return;
      }

      gs.currentPlayerIndex = playerIndex;
      gs.lastPlay = null;
    }

    refillBank(room);

    if (gs.bank.length === 0) return;

    const card = gs.bank.pop();
    gs.hands[socket.id].push(card);
    sortHand(gs.hands[socket.id]);

    advanceTurn(room);
    emitGameState(room);
  });

  socket.on('play-again', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.players.length !== room.maxPlayers) return;
    startGame(room);
  });

  socket.on('leave-room', () => {
    leaveRoom(socket, true);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket, false);
  });

  function leaveRoom(sock, isExplicit) {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    for (const p of room.players) {
      if (p.id !== sock.id) {
        io.to(p.id).emit('opponent-disconnected');
      }
    }

    if (isExplicit) {
      rooms.delete(currentRoom);
    }
    currentRoom = null;
  }
});

// ─── Mega Tic Tac Toe ────────────────────────────────────────────────────────

const tttRooms = new Map();

function generateTTTRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (tttRooms.has(code));
  return code;
}

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function checkSmallBoard(cells) {
  for (const [a, b, c] of WIN_LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  if (cells.every(cell => cell !== null)) return 'draw';
  return null;
}

function checkMacroBoard(boardWinners) {
  for (const [a, b, c] of WIN_LINES) {
    const wa = boardWinners[a], wb = boardWinners[b], wc = boardWinners[c];
    if (wa && wa !== 'draw' && wa === wb && wa === wc) return wa;
  }
  if (boardWinners.every(w => w !== null)) return 'draw';
  return null;
}

function startTTTGame(room) {
  room.gameState = {
    boards: Array.from({ length: 9 }, () => Array(9).fill(null)),
    boardWinners: Array(9).fill(null),
    activeBoard: null,
    currentPlayer: 'X',
    phase: 'PLAYING',
    winner: null
  };
  emitTTTGameState(room);
}

function emitTTTGameState(room) {
  const gs = room.gameState;
  room.players.forEach((player, idx) => {
    const symbol = idx === 0 ? 'X' : 'O';
    ttt.to(player.id).emit('game-state', {
      boards: gs.boards,
      boardWinners: gs.boardWinners,
      activeBoard: gs.activeBoard,
      currentPlayer: gs.currentPlayer,
      phase: gs.phase,
      winner: gs.winner,
      yourSymbol: symbol,
      isYourTurn: gs.currentPlayer === symbol && gs.phase === 'PLAYING',
      yourName: player.name,
      opponentName: room.players[1 - idx] ? room.players[1 - idx].name : ''
    });
  });
}

const ttt = io.of('/ttt');

ttt.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name }) => {
    const code = generateTTTRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: name || 'Player 1' }],
      gameState: null
    };
    tttRooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    socket.emit('room-created', { code });
    socket.emit('room-update', { players: room.players.map(p => p.name), maxPlayers: 2 });
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = tttRooms.get(code);

    if (!room) {
      socket.emit('error-msg', { message: 'Room not found.' });
      return;
    }

    // Reconnection: room already has 2 players
    if (room.players.length >= 2) {
      const disconnectedIdx = room.players.findIndex(p => !ttt.sockets.get(p.id));
      if (disconnectedIdx === -1) {
        socket.emit('error-msg', { message: 'Room is full.' });
        return;
      }
      room.players[disconnectedIdx].id = socket.id;
      if (name) room.players[disconnectedIdx].name = name;
      currentRoom = code;
      socket.join(code);

      for (const p of room.players) {
        ttt.to(p.id).emit('room-update', { players: room.players.map(pl => pl.name), maxPlayers: 2 });
      }
      if (room.gameState) emitTTTGameState(room);
      return;
    }

    room.players.push({ id: socket.id, name: name || 'Player 2' });
    currentRoom = code;
    socket.join(code);

    for (const p of room.players) {
      ttt.to(p.id).emit('room-update', { players: room.players.map(pl => pl.name), maxPlayers: 2 });
    }

    startTTTGame(room);
  });

  socket.on('make-move', ({ boardIndex, cellIndex }) => {
    if (!currentRoom) return;
    const room = tttRooms.get(currentRoom);
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    if (gs.phase !== 'PLAYING') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const symbol = playerIndex === 0 ? 'X' : 'O';
    if (gs.currentPlayer !== symbol) return;

    if (boardIndex < 0 || boardIndex > 8 || cellIndex < 0 || cellIndex > 8) return;
    if (gs.boardWinners[boardIndex] !== null) return;
    if (gs.activeBoard !== null && gs.activeBoard !== boardIndex) return;
    if (gs.boards[boardIndex][cellIndex] !== null) return;

    gs.boards[boardIndex][cellIndex] = symbol;

    const smallResult = checkSmallBoard(gs.boards[boardIndex]);
    if (smallResult !== null) gs.boardWinners[boardIndex] = smallResult;

    const macroResult = checkMacroBoard(gs.boardWinners);
    if (macroResult !== null) {
      gs.phase = 'GAME_OVER';
      gs.winner = macroResult;
      emitTTTGameState(room);
      return;
    }

    gs.activeBoard = gs.boardWinners[cellIndex] === null ? cellIndex : null;
    gs.currentPlayer = gs.currentPlayer === 'X' ? 'O' : 'X';
    emitTTTGameState(room);
  });

  socket.on('play-again', () => {
    if (!currentRoom) return;
    const room = tttRooms.get(currentRoom);
    if (!room || room.players.length !== 2) return;
    if (!room.gameState || room.gameState.phase !== 'GAME_OVER') return;
    startTTTGame(room);
  });

  socket.on('leave-room', () => {
    leaveTTTRoom(socket, true);
  });

  socket.on('disconnect', () => {
    leaveTTTRoom(socket, false);
  });

  function leaveTTTRoom(sock, isExplicit) {
    if (!currentRoom) return;
    const room = tttRooms.get(currentRoom);
    if (!room) return;

    for (const p of room.players) {
      if (p.id !== sock.id) {
        ttt.to(p.id).emit('opponent-disconnected');
      }
    }

    if (isExplicit) {
      tttRooms.delete(currentRoom);
    }
    currentRoom = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});
