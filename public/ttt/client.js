'use strict';

const socket = io('/ttt');

// ── DOM refs ──────────────────────────────────────────────────────────────────
const lobbyEl           = document.getElementById('lobby');
const gameEl            = document.getElementById('game');
const playerNameInput   = document.getElementById('player-name');
const createBtn         = document.getElementById('create-btn');
const roomCodeDisplay   = document.getElementById('room-code-display');
const roomCodeValue     = document.getElementById('room-code-value');
const joinCodeInput     = document.getElementById('join-code');
const joinBtn           = document.getElementById('join-btn');
const lobbyError        = document.getElementById('lobby-error');

const yourSymbolBadge   = document.getElementById('your-symbol-badge');
const yourNameLabel     = document.getElementById('your-name-label');
const opponentSymbolBadge = document.getElementById('opponent-symbol-badge');
const opponentNameLabel = document.getElementById('opponent-name-label');
const turnIndicator     = document.getElementById('turn-indicator');
const macroBoardEl      = document.getElementById('macro-board');

const gameOverOverlay   = document.getElementById('game-over-overlay');
const gameOverTitle     = document.getElementById('game-over-title');
const gameOverSubtitle  = document.getElementById('game-over-subtitle');
const playAgainBtn      = document.getElementById('play-again-btn');
const leaveBtn          = document.getElementById('leave-btn');

const disconnectOverlay   = document.getElementById('disconnect-overlay');
const backToLobbyBtn      = document.getElementById('back-to-lobby-btn');

// ── Pre-built board DOM (build once, update in place) ─────────────────────────
const boardEls = [];   // boardEls[boardIdx]
const cellEls  = [];   // cellEls[boardIdx][cellIdx]

(function buildGrid() {
  for (let b = 0; b < 9; b++) {
    const boardEl = document.createElement('div');
    boardEl.className = 'small-board';
    boardEl.dataset.board = b;
    cellEls[b] = [];

    for (let c = 0; c < 9; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'cell';
      cellEl.dataset.board = b;
      cellEl.dataset.cell = c;
      cellEls[b][c] = cellEl;
      boardEl.appendChild(cellEl);
    }

    boardEls[b] = boardEl;
    macroBoardEl.appendChild(boardEl);
  }
})();

// ── State ────────────────────────────────────────────────────────────────────
let mySymbol = null;

// ── Lobby events ──────────────────────────────────────────────────────────────
createBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player 1';
  socket.emit('create-room', { name });
  createBtn.disabled = true;
});

joinBtn.addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) return;
  const name = playerNameInput.value.trim() || 'Player 2';
  socket.emit('join-room', { code, name });
  joinBtn.disabled = true;
});

joinCodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click();
});

// ── Game action events ─────────────────────────────────────────────────────────
playAgainBtn.addEventListener('click', () => {
  socket.emit('play-again');
  gameOverOverlay.classList.add('hidden');
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  resetToLobby();
});

backToLobbyBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  resetToLobby();
});

// ── Socket handlers ───────────────────────────────────────────────────────────
socket.on('room-created', ({ code }) => {
  roomCodeValue.textContent = code;
  roomCodeDisplay.classList.remove('hidden');
});

socket.on('room-update', ({ players }) => {
  // Nothing to render in lobby beyond showing the code;
  // game-state handles the game screen.
});

socket.on('game-state', (state) => {
  mySymbol = state.yourSymbol;
  showGame();
  renderGame(state);
});

socket.on('error-msg', ({ message }) => {
  showLobbyError(message);
  createBtn.disabled = false;
  joinBtn.disabled = false;
});

socket.on('opponent-disconnected', () => {
  disconnectOverlay.classList.remove('hidden');
});

// ── Rendering ────────────────────────────────────────────────────────────────
function renderGame(state) {
  // Status bar
  renderStatusBar(state);

  // Hide overlays when a fresh game arrives
  if (state.phase === 'PLAYING') {
    gameOverOverlay.classList.add('hidden');
    disconnectOverlay.classList.add('hidden');
  }

  // Boards
  for (let b = 0; b < 9; b++) {
    const boardEl = boardEls[b];
    const winner  = state.boardWinners[b];

    // Reset classes
    boardEl.className = 'small-board';
    delete boardEl.dataset.winner;

    if (winner) {
      boardEl.classList.add('won');
      if (winner === 'X')    { boardEl.classList.add('won-x'); boardEl.dataset.winner = 'X'; }
      else if (winner === 'O') { boardEl.classList.add('won-o'); boardEl.dataset.winner = 'O'; }
      else                   { boardEl.classList.add('won-draw'); boardEl.dataset.winner = '='; }
    } else if (state.phase === 'PLAYING') {
      if (state.activeBoard === null) {
        boardEl.classList.add('active-any');
      } else if (state.activeBoard === b) {
        boardEl.classList.add('active');
      }
    }

    // Cells
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

  // Game over overlay
  if (state.phase === 'GAME_OVER') {
    showGameOver(state);
  }
}

function renderStatusBar(state) {
  // Your badge
  yourSymbolBadge.className = `symbol-badge ${state.yourSymbol.toLowerCase()}`;
  yourSymbolBadge.textContent = state.yourSymbol;
  yourNameLabel.textContent = state.yourName;

  // Opponent badge
  const oppSymbol = state.yourSymbol === 'X' ? 'O' : 'X';
  opponentSymbolBadge.className = `symbol-badge ${oppSymbol.toLowerCase()}`;
  opponentSymbolBadge.textContent = oppSymbol;
  opponentNameLabel.textContent = state.opponentName || 'Opponent';

  // Turn indicator
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function showGame() {
  lobbyEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
}

function resetToLobby() {
  lobbyEl.classList.remove('hidden');
  gameEl.classList.add('hidden');
  gameOverOverlay.classList.add('hidden');
  disconnectOverlay.classList.add('hidden');
  roomCodeDisplay.classList.add('hidden');
  roomCodeValue.textContent = '';
  joinCodeInput.value = '';
  createBtn.disabled = false;
  joinBtn.disabled = false;
  mySymbol = null;
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
