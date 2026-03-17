const socket = io();

// DOM elements
const lobbyEl = document.getElementById('lobby');
const gameEl = document.getElementById('game');
const playerNameInput = document.getElementById('player-name');
const maxPlayersSelect = document.getElementById('max-players');
const btnCreate = document.getElementById('btn-create');
const roomCodeDisplay = document.getElementById('room-code-display');
const roomCodeEl = document.getElementById('room-code');
const waitingText = document.getElementById('waiting-text');
const joinCodeInput = document.getElementById('join-code');
const btnJoin = document.getElementById('btn-join');
const lobbyError = document.getElementById('lobby-error');

const opponentsArea = document.getElementById('opponents-area');
const topCardEl = document.getElementById('top-card');
const pileCountEl = document.getElementById('pile-count');
const bankCountEl = document.getElementById('bank-count');
const turnIndicatorEl = document.getElementById('turn-indicator');
const declaredInfoEl = document.getElementById('declared-info');
const handEl = document.getElementById('hand');
const btnDraw = document.getElementById('btn-draw');
const btnCheat = document.getElementById('btn-cheat');
const declareArea = document.getElementById('declare-area');
const declareButtons = document.getElementById('declare-buttons');

const challengeOverlay = document.getElementById('challenge-overlay');
const challengeTitle = document.getElementById('challenge-title');
const revealedCardContainer = document.getElementById('revealed-card-container');
const challengeDeclared = document.getElementById('challenge-declared');
const challengeMessage = document.getElementById('challenge-message');

const gameoverOverlay = document.getElementById('gameover-overlay');
const gameoverTitle = document.getElementById('gameover-title');
const btnPlayAgain = document.getElementById('btn-play-again');
const btnLeave = document.getElementById('btn-leave');

const disconnectOverlay = document.getElementById('disconnect-overlay');
const btnBackLobby = document.getElementById('btn-back-lobby');

// State
let selectedIndex = null;
let currentState = null;

// ── LOBBY ──

btnCreate.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player 1';
  const maxPlayers = parseInt(maxPlayersSelect.value) || 2;
  socket.emit('create-room', { name, maxPlayers });
  btnCreate.disabled = true;
});

btnJoin.addEventListener('click', () => {
  const code = joinCodeInput.value.trim();
  const name = playerNameInput.value.trim() || 'Player';
  if (!code) return;
  socket.emit('join-room', { code, name });
});

joinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

socket.on('room-created', ({ code, maxPlayers }) => {
  roomCodeDisplay.classList.remove('hidden');
  roomCodeEl.textContent = code;
  waitingText.textContent = 'Waiting for players... (1/' + maxPlayers + ')';
});

socket.on('room-update', ({ players, maxPlayers }) => {
  waitingText.textContent = 'Players: ' + players.join(', ') + ' (' + players.length + '/' + maxPlayers + ')';
});

socket.on('error-msg', ({ message }) => {
  lobbyError.textContent = message;
  lobbyError.classList.remove('hidden');
  setTimeout(() => lobbyError.classList.add('hidden'), 3000);
});

// ── GAME ──

socket.on('game-state', (state) => {
  currentState = state;
  selectedIndex = null;

  declareArea.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  disconnectOverlay.classList.add('hidden');

  lobbyEl.classList.add('hidden');
  gameEl.classList.remove('hidden');

  renderGame();
});

function renderGame() {
  const s = currentState;
  if (!s) return;

  // Opponents area
  opponentsArea.innerHTML = '';
  s.opponents.forEach(opp => {
    const div = document.createElement('div');
    div.className = 'opponent-badge';
    div.innerHTML = '<span class="opp-name">' + opp.name + '</span>' +
                    '<span class="opp-cards">' + opp.cardCount + ' cards</span>';
    opponentsArea.appendChild(div);
  });

  // Bank
  bankCountEl.textContent = s.bankSize;

  // Pile
  pileCountEl.textContent = s.pileSize;

  // Top of pile
  topCardEl.innerHTML = '';
  if (s.phase === 'CHALLENGE' && s.declaredRank) {
    const faceDown = document.createElement('div');
    faceDown.className = 'card-facedown';
    faceDown.innerHTML = '<span class="claimed-rank">' + s.declaredRank + '</span>';
    topCardEl.appendChild(faceDown);
  } else if (s.topCard) {
    topCardEl.appendChild(createCardElement(s.topCard, false, true));
  } else if (s.topRank) {
    const rankDisplay = document.createElement('div');
    rankDisplay.className = 'top-rank-display';
    rankDisplay.textContent = s.topRank;
    topCardEl.appendChild(rankDisplay);
  }

  // Turn indicator
  if (s.phase === 'GAME_OVER') {
    turnIndicatorEl.textContent = 'Game Over';
    turnIndicatorEl.className = '';
  } else if (s.isYourTurn && s.phase === 'PLAY') {
    turnIndicatorEl.textContent = 'Your turn \u2014 pick a card to play';
    turnIndicatorEl.className = 'your-turn';
  } else if (!s.isYourTurn && s.phase === 'PLAY') {
    turnIndicatorEl.textContent = s.currentPlayerName + ' is playing...';
    turnIndicatorEl.className = 'opponent-turn';
  } else if (s.phase === 'CHALLENGE') {
    if (s.isYourTurn) {
      turnIndicatorEl.textContent = s.lastPlayerName + ' played a card \u2014 Call Cheat or play your card';
      turnIndicatorEl.className = 'your-turn';
    } else {
      turnIndicatorEl.textContent = 'Waiting for ' + s.currentPlayerName + '...';
      turnIndicatorEl.className = 'opponent-turn';
    }
  }

  declaredInfoEl.classList.add('hidden');

  // Action buttons
  btnDraw.classList.add('hidden');
  btnCheat.classList.add('hidden');

  if (s.phase === 'PLAY' && s.isYourTurn) {
    if (s.bankSize > 0) {
      btnDraw.classList.remove('hidden');
    }
  } else if (s.phase === 'CHALLENGE' && s.isYourTurn) {
    btnCheat.classList.remove('hidden');
    if (s.bankSize > 0) {
      btnDraw.classList.remove('hidden');
    }
  }

  renderHand();
}

function renderHand() {
  handEl.innerHTML = '';
  const hand = currentState.hand;

  hand.forEach((card, idx) => {
    const cardEl = createCardElement(card);

    if (selectedIndex === idx) {
      cardEl.classList.add('selected');
    }

    const canPlay = (currentState.phase === 'PLAY' && currentState.isYourTurn) ||
                    (currentState.phase === 'CHALLENGE' && currentState.isYourTurn);
    if (canPlay) {
      cardEl.addEventListener('click', () => {
        if (selectedIndex === idx) {
          selectedIndex = null;
          declareArea.classList.add('hidden');
        } else {
          selectedIndex = idx;
          showDeclareOptions();
        }
        renderHand();
      });
    } else {
      cardEl.style.cursor = 'default';
    }

    handEl.appendChild(cardEl);
  });
}

function showDeclareOptions() {
  const s = currentState;
  if (!s.validRanks || s.validRanks.length === 0) return;

  declareButtons.innerHTML = '';
  s.validRanks.forEach(rank => {
    const btn = document.createElement('button');
    btn.className = 'declare-btn';
    btn.textContent = rank;
    btn.addEventListener('click', () => {
      socket.emit('play-card', { cardIndex: selectedIndex, declaredRank: rank });
      selectedIndex = null;
      declareArea.classList.add('hidden');
    });
    declareButtons.appendChild(btn);
  });

  declareArea.classList.remove('hidden');
}

function createCardElement(card, isRevealed, isTopCard) {
  const el = document.createElement('div');
  const isRed = card.suit === '\u2665' || card.suit === '\u2666';
  el.className = 'card ' + (isRed ? 'red' : 'black');
  if (isRevealed) el.classList.add('revealed');
  if (isTopCard) el.classList.add('top-card');

  el.innerHTML =
    '<div class="top">' + card.rank + card.suit + '</div>' +
    '<div class="center-suit">' + card.suit + '</div>' +
    '<div class="bottom">' + card.rank + card.suit + '</div>';

  return el;
}

// Draw from bank
btnDraw.addEventListener('click', () => {
  socket.emit('draw-card');
  declareArea.classList.add('hidden');
  selectedIndex = null;
});

// Call cheat
btnCheat.addEventListener('click', () => {
  socket.emit('call-cheat');
});

// Challenge result
socket.on('challenge-result', ({ wasCheating, revealedCard, declaredRank, message }) => {
  challengeTitle.textContent = wasCheating ? 'Caught Cheating!' : 'Not Cheating!';
  challengeTitle.className = wasCheating ? 'cheat-caught' : 'cheat-clear';
  challengeMessage.textContent = message;
  challengeDeclared.textContent = 'Declared: ' + declaredRank + ' \u2014 Actual: ' + revealedCard.rank + revealedCard.suit;

  revealedCardContainer.innerHTML = '';
  revealedCardContainer.appendChild(createCardElement(revealedCard, true));

  challengeOverlay.classList.remove('hidden');

  setTimeout(() => {
    challengeOverlay.classList.add('hidden');
  }, 3000);
});

// Game over
socket.on('game-over', ({ won, winnerName }) => {
  if (won) {
    gameoverTitle.textContent = 'You Win!';
    gameoverTitle.className = 'win-title';
  } else {
    gameoverTitle.textContent = winnerName + ' Wins!';
    gameoverTitle.className = 'lose-title';
  }
  gameoverOverlay.classList.remove('hidden');
});

btnPlayAgain.addEventListener('click', () => {
  gameoverOverlay.classList.add('hidden');
  socket.emit('play-again');
});

btnLeave.addEventListener('click', () => {
  socket.emit('leave-room');
  backToLobby();
});

// Disconnect
socket.on('opponent-disconnected', () => {
  disconnectOverlay.classList.remove('hidden');
});

btnBackLobby.addEventListener('click', () => {
  backToLobby();
});

function backToLobby() {
  gameEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  roomCodeDisplay.classList.add('hidden');
  btnCreate.disabled = false;
  lobbyError.classList.add('hidden');
  currentState = null;
  selectedIndex = null;
  gameoverOverlay.classList.add('hidden');
  challengeOverlay.classList.add('hidden');
  disconnectOverlay.classList.add('hidden');
  declareArea.classList.add('hidden');
}
