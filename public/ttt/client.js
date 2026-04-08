'use strict';

const socket = io('/ttt', {
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

// ── DOM refs ──────────────────────────────────────────────────────────────────
const lobbyEl              = document.getElementById('lobby');
const gameEl               = document.getElementById('game');
const playerNameInput      = document.getElementById('player-name');
const createBtn            = document.getElementById('create-btn');
const roomCodeDisplay      = document.getElementById('room-code-display');
const roomCodeValue        = document.getElementById('room-code-value');
const joinCodeInput        = document.getElementById('join-code');
const joinBtn              = document.getElementById('join-btn');
const lobbyError           = document.getElementById('lobby-error');

const yourSymbolBadge      = document.getElementById('your-symbol-badge');
const yourNameLabel        = document.getElementById('your-name-label');
const opponentSymbolBadge  = document.getElementById('opponent-symbol-badge');
const opponentNameLabel    = document.getElementById('opponent-name-label');
const turnIndicator        = document.getElementById('turn-indicator');
const macroBoardEl         = document.getElementById('macro-board');

const gameOverOverlay      = document.getElementById('game-over-overlay');
const gameOverTitle        = document.getElementById('game-over-title');
const gameOverSubtitle     = document.getElementById('game-over-subtitle');
const playAgainBtn         = document.getElementById('play-again-btn');
const leaveBtn             = document.getElementById('leave-btn');

const disconnectOverlay    = document.getElementById('disconnect-overlay');
const backToLobbyBtn       = document.getElementById('back-to-lobby-btn');
const reconnectingOverlay  = document.getElementById('reconnecting-overlay');

// ── Pre-built board DOM (build once, update in place) ─────────────────────────
const boardEls = [];
const cellEls  = [];

(function buildGrid() {
  for (let b = 0; b < 9; b++) {
    const boardEl = document.createElement('div');
    boardEl.className = 'small-board';
    cellEls[b] = [];
    for (let c = 0; c < 9; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell';
      cellEls[b][c] = cellEl;
      boardEl.appendChild(cellEl);
    }
    boardEls[b] = boardEl;
    macroBoardEl.appendChild(boardEl);
  }
})();

// ── Session state (persists across reconnects) ────────────────────────────────
let mySymbol      = null;
let storedRoom    = null;  // { code, name } — set when we join a room
let inGame        = false; // true once we've received at least one game-state

// ── Lobby events ──────────────────────────────────────────────────────────────
createBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player 1';
  storedRoom = { code: null, name }; // code filled in on room-created
  socket.emit('create-room', { name });
  createBtn.disabled = true;
});

joinBtn.addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) return;
  const name = playerNameInput.value.trim() || 'Player 2';
  storedRoom = { code, name };
  socket.emit('join-room', { code, name });
  joinBtn.disabled = true;
});

joinCodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click();
});

// ── Game action events ────────────────────────────────────────────────────────
playAgainBtn.addEventListener('click', () => {
  socket.emit('play-again');
  gameOverOverlay.classList.add('hidden');
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  clearSession();
  resetToLobby();
});

backToLobbyBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  clearSession();
  resetToLobby();
});

// ── Socket lifecycle ──────────────────────────────────────────────────────────
socket.on('connect', () => {
  // Auto-rejoin if we were in a game when the connection dropped
  if (storedRoom && storedRoom.code && inGame) {
    reconnectingOverlay.classList.remove('hidden');
    socket.emit('join-room', { code: storedRoom.code, name: storedRoom.name });
  }
});

socket.on('disconnect', () => {
  // Only show reconnecting if we were in a game, not in the lobby
  if (inGame) {
    reconnectingOverlay.classList.remove('hidden');
  }
});

// ── Socket game events ────────────────────────────────────────────────────────
socket.on('room-created', ({ code }) => {
  if (storedRoom) storedRoom.code = code;
  roomCodeValue.textContent = code;
  roomCodeDisplay.classList.remove('hidden');
});

socket.on('room-update', () => {
  // Lobby display only — game-state handles everything once game starts
});

socket.on('game-state', (state) => {
  mySymbol = state.yourSymbol;
  inGame   = true;
  reconnectingOverlay.classList.add('hidden');
  showGame();
  renderGame(state);
});

socket.on('error-msg', ({ message }) => {
  reconnectingOverlay.classList.add('hidden');
  // If we were trying to reconnect and the room is gone, go back to lobby
  if (inGame) {
    clearSession();
    resetToLobby();
    showLobbyError('Your room is no longer available. Please start a new game.');
  } else {
    showLobbyError(message);
    createBtn.disabled = false;
    joinBtn.disabled = false;
  }
});

socket.on('opponent-disconnected', () => {
  reconnectingOverlay.classList.add('hidden');
  disconnectOverlay.classList.remove('hidden');
});

// ── Rendering ────────────────────────────────────────────────────────────────
function renderGame(state) {
  renderStatusBar(state);

  if (state.phase === 'PLAYING') {
    gameOverOverlay.classList.add('hidden');
    disconnectOverlay.classList.add('hidden');
  }

  for (let b = 0; b < 9; b++) {
    const boardEl = boardEls[b];
    const winner  = state.boardWinners[b];

    boardEl.className = 'small-board';
    delete boardEl.dataset.winner;

    if (winner) {
      boardEl.classList.add('won');
      if (winner === 'X')      { boardEl.classList.add('won-x'); boardEl.dataset.winner = 'X'; }
      else if (winner === 'O') { boardEl.classList.add('won-o'); boardEl.dataset.winner = 'O'; }
      else                     { boardEl.classList.add('won-draw'); boardEl.dataset.winner = '='; }
    } else if (state.phase === 'PLAYING') {
      if (state.activeBoard === null)  boardEl.classList.add('active-any');
      else if (state.activeBoard === b) boardEl.classList.add('active');
    }

    for (let c = 0; c < 9; c++) {
      const cellEl = cellEls[b][c];
      const mark   = state.boards[b][c];

      cellEl.className = 'cell';
      cellEl.textContent = mark || '';
      if (mark === 'X') cellEl.classList.add('x');
      if (mark === 'O') cellEl.classList.add('o');
      cellEl.onclick = null;

      const playable = state.isYourTurn
        && state.phase === 'PLAYING'
        && !winner
        && mark === null
        && (state.activeBoard === null || state.activeBoard === b);

      if (playable) {
        cellEl.classList.add('playable');
        cellEl.onclick = () => socket.emit('make-move', { boardIndex: b, cellIndex: c });
      }
    }
  }

  if (state.phase === 'GAME_OVER') showGameOver(state);
}

function renderStatusBar(state) {
  yourSymbolBadge.className = `symbol-badge ${state.yourSymbol.toLowerCase()}`;
  yourSymbolBadge.textContent = state.yourSymbol;
  yourNameLabel.textContent = state.yourName;

  const oppSymbol = state.yourSymbol === 'X' ? 'O' : 'X';
  opponentSymbolBadge.className = `symbol-badge ${oppSymbol.toLowerCase()}`;
  opponentSymbolBadge.textContent = oppSymbol;
  opponentNameLabel.textContent = state.opponentName || 'Opponent';

  if (state.phase === 'GAME_OVER') {
    turnIndicator.className = 'their-turn';
    turnIndicator.textContent = 'Game over';
  } else if (state.isYourTurn) {
    turnIndicator.className = 'your-turn';
    turnIndicator.textContent = 'Your turn';
  } else {
    turnIndicator.className = 'their-turn';
    turnIndicator.textContent = `${state.opponentName || 'Opponent'}'s turn`;
  }
}

function showGameOver(state) {
  gameOverOverlay.classList.remove('hidden');
  if (state.winner === 'draw') {
    gameOverTitle.className = 'draw';
    gameOverTitle.textContent = "It's a Draw!";
    gameOverSubtitle.textContent = 'No one won the macro board.';
  } else if (state.winner === mySymbol) {
    gameOverTitle.className = 'win';
    gameOverTitle.textContent = 'You Win!';
    gameOverSubtitle.textContent = `${state.yourName} (${mySymbol}) takes the macro board!`;
  } else {
    gameOverTitle.className = 'lose';
    gameOverTitle.textContent = 'You Lose';
    gameOverSubtitle.textContent = `${state.opponentName || 'Opponent'} (${state.winner}) wins the macro board.`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showGame() {
  lobbyEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
}

function clearSession() {
  storedRoom = null;
  inGame     = false;
  mySymbol   = null;
}

function resetToLobby() {
  lobbyEl.classList.remove('hidden');
  gameEl.classList.add('hidden');
  gameOverOverlay.classList.add('hidden');
  disconnectOverlay.classList.add('hidden');
  reconnectingOverlay.classList.add('hidden');
  roomCodeDisplay.classList.add('hidden');
  roomCodeValue.textContent = '';
  joinCodeInput.value = '';
  createBtn.disabled = false;
  joinBtn.disabled = false;
  clearLobbyError();
}

function showLobbyError(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove('hidden');
}

function clearLobbyError() {
  lobbyError.textContent = '';
  lobbyError.classList.add('hidden');
}
