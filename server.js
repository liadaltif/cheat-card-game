const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

// Keep Render's free tier from spinning down the server
app.get('/ping', (req, res) => res.sendStatus(200));

app.get('/ttt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ttt', 'index.html'));
});

app.get('/sh', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sh', 'index.html'));
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
    currentPlayer: Math.random() < 0.5 ? 'X' : 'O',
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
      const disconnectedIdx = room.players.findIndex(p => !ttt.sockets.get(p.id)?.connected);
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

// ─── Shithead / Palace ───────────────────────────────────────────────────────

const shRooms = new Map();

function generateSHRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (shRooms.has(code));
  return code;
}

const SH_SUITS = ['♠', '♥', '♦', '♣'];
const SH_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function mkSHDeck() {
  let n = 0;
  const deck = SH_SUITS.flatMap(s => SH_RANKS.map(r => ({ s, r, id: n++ })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function shEffTop(pile) {
  for (let i = pile.length - 1; i >= 0; i--) if (pile[i].r !== 3) return pile[i];
  return null;
}

function shCanPlay(card, pile, u7) {
  if (card.r === 2 || card.r === 3 || card.r === 10) return true;
  const t = shEffTop(pile);
  if (!t) return true;
  return u7 ? card.r <= 7 : card.r >= t.r;
}

function shBurnCheck(pile) {
  return pile.length >= 4 && pile.slice(-4).every(c => c.r === pile[pile.length - 1].r);
}

function shSrcOf(gs, idx) {
  if (gs.hands[idx].length) return 'h';
  if (gs.faceUp[idx].length) return 'fu';
  return 'fd';
}

function shIsDone(gs, idx) {
  return !gs.hands[idx].length && !gs.faceUp[idx].length && !gs.faceDown[idx].length;
}

function startSHGame(room) {
  const deck = mkSHDeck();
  const take = n => deck.splice(0, n);
  room.gameState = {
    phase: 'setup',
    hands: [take(3), take(3)],
    faceUp: [take(3), take(3)],
    faceDown: [take(3), take(3)],
    draw: deck,
    pile: [],
    turn: null,
    u7: false,
    ready: [false, false],
    winner: null,
    lastAction: 'Swap hand cards with face-up cards, then click Ready.'
  };
  emitSHGameState(room);
}

function getSHPlayerView(room, playerIdx) {
  const gs = room.gameState;
  const oppIdx = 1 - playerIdx;
  const src = gs.phase === 'playing' ? shSrcOf(gs, playerIdx) : 'h';
  return {
    phase: gs.phase,
    turn: gs.turn,
    u7: gs.u7,
    isYourTurn: gs.turn === playerIdx && gs.phase === 'playing',
    yourIndex: playerIdx,
    yourName: room.players[playerIdx].name,
    lastAction: gs.lastAction,
    ready: gs.ready,
    hand: gs.hands[playerIdx],
    faceUp: gs.faceUp[playerIdx],
    faceDownCount: gs.faceDown[playerIdx].length,
    opponentName: room.players[oppIdx] ? room.players[oppIdx].name : '',
    opponentHandCount: gs.hands[oppIdx].length,
    opponentFaceUp: gs.faceUp[oppIdx],
    opponentFaceDownCount: gs.faceDown[oppIdx].length,
    pileTop: gs.pile.length ? gs.pile[gs.pile.length - 1] : null,
    pileSecond: gs.pile.length >= 2 ? gs.pile[gs.pile.length - 2] : null,
    pileCount: gs.pile.length,
    drawCount: gs.draw.length,
    source: src,
    winner: gs.winner,
    winnerName: gs.winner !== null ? room.players[gs.winner].name : null
  };
}

function emitSHGameState(room) {
  room.players.forEach((player, idx) => {
    sh.to(player.id).emit('game-state', getSHPlayerView(room, idx));
  });
}

const sh = io.of('/sh');

sh.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name }) => {
    const code = generateSHRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: name || 'Player 1' }],
      gameState: null
    };
    shRooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    socket.emit('room-created', { code });
    socket.emit('room-update', { players: room.players.map(p => p.name), maxPlayers: 2 });
  });

  socket.on('join-room', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = shRooms.get(code);
    if (!room) { socket.emit('error-msg', { message: 'Room not found.' }); return; }

    if (room.players.length >= 2) {
      const disconnectedIdx = room.players.findIndex(p => !sh.sockets.get(p.id)?.connected);
      if (disconnectedIdx === -1) { socket.emit('error-msg', { message: 'Room is full.' }); return; }
      room.players[disconnectedIdx].id = socket.id;
      if (name) room.players[disconnectedIdx].name = name;
      currentRoom = code;
      socket.join(code);
      for (const p of room.players) {
        sh.to(p.id).emit('room-update', { players: room.players.map(pl => pl.name), maxPlayers: 2 });
      }
      if (room.gameState) emitSHGameState(room);
      return;
    }

    room.players.push({ id: socket.id, name: name || 'Player 2' });
    currentRoom = code;
    socket.join(code);
    for (const p of room.players) {
      sh.to(p.id).emit('room-update', { players: room.players.map(pl => pl.name), maxPlayers: 2 });
    }
    startSHGame(room);
  });

  socket.on('swap-cards', ({ handCardId, faceUpCardId }) => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'setup') return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1 || gs.ready[pi]) return;

    const hi = gs.hands[pi].findIndex(c => c.id === handCardId);
    const fi = gs.faceUp[pi].findIndex(c => c.id === faceUpCardId);
    if (hi === -1 || fi === -1) return;

    [gs.hands[pi][hi], gs.faceUp[pi][fi]] = [gs.faceUp[pi][fi], gs.hands[pi][hi]];
    emitSHGameState(room);
  });

  socket.on('ready', () => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'setup') return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1) return;

    gs.ready[pi] = true;
    if (gs.ready[0] && gs.ready[1]) {
      gs.phase = 'playing';
      gs.turn = Math.random() < 0.5 ? 0 : 1;
      gs.lastAction = `Coin flip — ${room.players[gs.turn].name} goes first!`;
    }
    emitSHGameState(room);
  });

  socket.on('play-cards', ({ cardIds }) => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'playing') return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1 || gs.turn !== pi) return;

    const src = shSrcOf(gs, pi);
    if (src === 'fd') return;

    const idSet = new Set(cardIds);
    const source = gs[src === 'h' ? 'hands' : 'faceUp'][pi];
    const cards = source.filter(c => idSet.has(c.id));
    if (!cards.length || cards.length !== cardIds.length) return;
    if (!cards.every(c => c.r === cards[0].r)) return;
    if (!shCanPlay(cards[0], gs.pile, gs.u7)) return;

    const rank = cards[0].r;
    // Remove cards from source
    if (src === 'h') gs.hands[pi] = gs.hands[pi].filter(c => !idSet.has(c.id));
    else gs.faceUp[pi] = gs.faceUp[pi].filter(c => !idSet.has(c.id));

    gs.pile.push(...cards);

    const burned = rank === 10 || shBurnCheck(gs.pile);
    if (burned) {
      gs.pile = [];
      for (const p of room.players) sh.to(p.id).emit('burn');
    }

    gs.u7 = !burned && rank === 7;

    // Refill hand from draw
    while (gs.hands[pi].length < 3 && gs.draw.length) gs.hands[pi].push(gs.draw.shift());

    if (shIsDone(gs, pi)) {
      gs.phase = 'over';
      gs.winner = pi;
      gs.lastAction = `${room.players[pi].name} wins!`;
    } else {
      const RN = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
      const lbl = cards.length > 1 ? `${cards.length}x ${RN[rank]}` : RN[rank];
      if (burned) {
        gs.lastAction = `${room.players[pi].name} played ${lbl} — burned the pile!`;
      } else {
        gs.turn = 1 - pi;
        gs.lastAction = gs.u7
          ? `${room.players[pi].name} played 7 — must play ≤ 7`
          : `${room.players[pi].name} played ${lbl}`;
      }
    }
    emitSHGameState(room);
  });

  socket.on('play-face-down', ({ index }) => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'playing') return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1 || gs.turn !== pi) return;
    if (shSrcOf(gs, pi) !== 'fd') return;
    if (index < 0 || index >= gs.faceDown[pi].length) return;

    const card = gs.faceDown[pi].splice(index, 1)[0];
    const playable = shCanPlay(card, gs.pile, gs.u7);

    if (playable) {
      gs.pile.push(card);
      const burned = card.r === 10 || shBurnCheck(gs.pile);
      if (burned) {
        gs.pile = [];
        for (const p of room.players) sh.to(p.id).emit('burn');
      }
      gs.u7 = !burned && card.r === 7;

      if (shIsDone(gs, pi)) {
        gs.phase = 'over';
        gs.winner = pi;
        gs.lastAction = `${room.players[pi].name} wins!`;
      } else if (!burned) {
        gs.turn = 1 - pi;
        gs.lastAction = `${room.players[pi].name} flipped a card and played it!`;
      } else {
        gs.lastAction = `${room.players[pi].name} flipped a card — burned the pile!`;
      }
    } else {
      // Not playable: card + pile go to hand
      gs.hands[pi].push(card, ...gs.pile);
      gs.pile = [];
      gs.u7 = false;
      gs.turn = 1 - pi;
      gs.lastAction = `${room.players[pi].name} flipped a card — couldn't play it, picked up the pile!`;
    }

    // Send reveal to both, then game-state after delay
    for (const p of room.players) {
      sh.to(p.id).emit('face-down-reveal', { card, playable, pickedUp: !playable });
    }
    setTimeout(() => { if (shRooms.has(currentRoom)) emitSHGameState(room); }, 1200);
  });

  socket.on('pick-up-pile', () => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.phase !== 'playing') return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1 || gs.turn !== pi) return;
    if (!gs.pile.length) return;

    gs.hands[pi].push(...gs.pile);
    gs.pile = [];
    gs.u7 = false;
    gs.turn = 1 - pi;
    gs.lastAction = `${room.players[pi].name} picked up the pile.`;
    emitSHGameState(room);
  });

  socket.on('play-again', () => {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room || room.players.length !== 2) return;
    if (!room.gameState || room.gameState.phase !== 'over') return;
    startSHGame(room);
  });

  socket.on('leave-room', () => { leaveSHRoom(socket, true); });
  socket.on('disconnect', () => { leaveSHRoom(socket, false); });

  function leaveSHRoom(sock, isExplicit) {
    if (!currentRoom) return;
    const room = shRooms.get(currentRoom);
    if (!room) return;
    for (const p of room.players) {
      if (p.id !== sock.id) sh.to(p.id).emit('opponent-disconnected');
    }
    if (isExplicit) shRooms.delete(currentRoom);
    currentRoom = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});
