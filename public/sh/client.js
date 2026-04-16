'use strict';

// Prevent Render free-tier spin-down
setInterval(() => fetch('/ping').catch(() => {}), 14 * 60 * 1000);

const socket = io('/sh', {
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

// ── Constants ────────────────────────────────────────────────────────────────
const RN = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };
const RED = new Set(['♥', '♦']);

// ── DOM refs ─────────────────────────────────────────────────────────────────
const lobbyEl            = document.getElementById('lobby');
const gameEl             = document.getElementById('game');
const playerNameInput    = document.getElementById('player-name');
const createBtn          = document.getElementById('create-btn');
const roomCodeDisplay    = document.getElementById('room-code-display');
const roomCodeValue      = document.getElementById('room-code-value');
const joinCodeInput      = document.getElementById('join-code');
const joinBtn            = document.getElementById('join-btn');
const lobbyError         = document.getElementById('lobby-error');

const statusMsg          = document.getElementById('status-msg');
const turnIndicator      = document.getElementById('turn-indicator');
const opponentPanel      = document.getElementById('opponent-panel');
const playerPanel        = document.getElementById('player-panel');
const btnsEl             = document.getElementById('btns');

const gameOverOverlay    = document.getElementById('game-over-overlay');
const gameOverTitle      = document.getElementById('game-over-title');
const gameOverSubtitle   = document.getElementById('game-over-subtitle');
const playAgainBtn       = document.getElementById('play-again-btn');
const leaveBtn           = document.getElementById('leave-btn');
const disconnectOverlay  = document.getElementById('disconnect-overlay');
const backToLobbyBtn     = document.getElementById('back-to-lobby-btn');
const reconnectingOverlay = document.getElementById('reconnecting-overlay');

// ── State ────────────────────────────────────────────────────────────────────
let storedRoom      = null;
let inGame          = false;
let currentState    = null;
let selectedCards   = new Set();
let swapCard        = null;   // hand card ID picked for swap (setup)

// ── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
let prevIsYourTurn = false;

document.addEventListener('click', () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
});

function playTurnSound() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.3, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  osc.start(t); osc.stop(t + 0.5);
}

// ── Pure helpers (for client-side dimming only; server validates) ─────────────
function effTop(pile) {
  for (let i = pile.length - 1; i >= 0; i--) if (pile[i].r !== 3) return pile[i];
  return null;
}
function canPlay(card, pileTop, pileSecond, pileCount, u7) {
  if (card.r === 2 || card.r === 3 || card.r === 10) return true;
  // Reconstruct minimal pile for effTop
  const pile = [];
  if (pileSecond) pile.push(pileSecond);
  if (pileTop) pile.push(pileTop);
  const t = effTop(pile);
  if (!t) return true;
  return u7 ? card.r <= 7 : card.r >= t.r;
}

// ── Card DOM creation (ported from palace.html) ──────────────────────────────
function mkCard(c, fd) {
  const el = document.createElement('div');
  el.className = 'card ' + (fd ? 'fd' : 'fu');
  if (!fd) {
    const tc = RED.has(c.s) ? 'red' : 'blk';
    el.innerHTML =
      `<div class="cr ${tc}">${RN[c.r]}<br><small>${c.s}</small></div>` +
      `<div class="cs ${tc}">${c.s}</div>` +
      `<div class="cr2 ${tc}">${RN[c.r]}<br><small>${c.s}</small></div>`;
  }
  return el;
}

function mkSlot() {
  const d = document.createElement('div');
  d.className = 'slot-ph';
  return d;
}

function setAct(el, a) { el.dataset.a = a; el.classList.add('ptr'); }

// ── Lobby events ─────────────────────────────────────────────────────────────
createBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player 1';
  storedRoom = { code: null, name };
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

joinCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

playAgainBtn.addEventListener('click', () => {
  socket.emit('play-again');
  gameOverOverlay.classList.add('hidden');
});
leaveBtn.addEventListener('click', () => { socket.emit('leave-room'); clearSession(); resetToLobby(); });
backToLobbyBtn.addEventListener('click', () => { socket.emit('leave-room'); clearSession(); resetToLobby(); });

// ── Socket lifecycle ─────────────────────────────────────────────────────────
socket.on('connect', () => {
  if (storedRoom && storedRoom.code && inGame) {
    reconnectingOverlay.classList.remove('hidden');
    socket.emit('join-room', { code: storedRoom.code, name: storedRoom.name });
  }
});

socket.on('disconnect', () => {
  if (inGame) reconnectingOverlay.classList.remove('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected && inGame) socket.connect();
});

// ── Socket game events ───────────────────────────────────────────────────────
socket.on('room-created', ({ code }) => {
  if (storedRoom) storedRoom.code = code;
  roomCodeValue.textContent = code;
  roomCodeDisplay.classList.remove('hidden');
});

socket.on('room-update', () => {});

socket.on('game-state', (state) => {
  currentState = state;
  inGame = true;
  reconnectingOverlay.classList.add('hidden');
  selectedCards = new Set();
  swapCard = null;
  showGame();
  render(state);

  if (state.isYourTurn && !prevIsYourTurn && state.phase === 'playing') playTurnSound();
  prevIsYourTurn = state.isYourTurn;
});

socket.on('face-down-reveal', ({ card, playable, pickedUp }) => {
  // Could add a reveal animation here — for now the 1.2s server delay
  // before the next game-state gives a natural pause
});

socket.on('burn', () => {
  const pp = document.getElementById('play-pile');
  if (pp) { pp.classList.add('burning'); setTimeout(() => pp.classList.remove('burning'), 450); }
});

socket.on('error-msg', ({ message }) => {
  reconnectingOverlay.classList.add('hidden');
  if (inGame) {
    clearSession(); resetToLobby();
    const reason = message === 'Room not found.'
      ? 'The server restarted and your game was lost. Please start a new game.'
      : `Couldn't rejoin: ${message} Please start a new game.`;
    showLobbyError(reason);
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

// ── Game action handler (event delegation) ───────────────────────────────────
gameEl.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  if (!a || !currentState) return;

  // Setup: select hand card for swap
  if (a.startsWith('sh-')) {
    const id = +a.slice(3);
    swapCard = (swapCard === id) ? null : id;
    render(currentState);
    return;
  }

  // Setup: swap with face-up card
  if (a.startsWith('sfu-')) {
    const fuid = +a.slice(4);
    if (swapCard === null) return;
    socket.emit('swap-cards', { handCardId: swapCard, faceUpCardId: fuid });
    swapCard = null;
    return;
  }

  // Setup: ready
  if (a === 'ready') { socket.emit('ready'); return; }

  // Playing: select hand/face-up card
  if (a.startsWith('ph-') || a.startsWith('pfu-')) {
    const id = +a.slice(a.indexOf('-') + 1);
    const card = [...currentState.hand, ...currentState.faceUp].find(c => c.id === id);
    if (!card) return;
    if (selectedCards.has(id)) {
      selectedCards.delete(id);
    } else {
      // Must be same rank as already selected
      if (selectedCards.size) {
        const first = [...currentState.hand, ...currentState.faceUp].find(c => c.id === [...selectedCards][0]);
        if (!first || first.r !== card.r) selectedCards.clear();
      }
      selectedCards.add(id);
    }
    render(currentState);
    return;
  }

  // Playing: play selected cards
  if (a === 'play') {
    if (!selectedCards.size) return;
    socket.emit('play-cards', { cardIds: [...selectedCards] });
    selectedCards = new Set();
    return;
  }

  // Playing: pick up pile
  if (a === 'pup') { socket.emit('pick-up-pile'); return; }

  // Playing: play face-down card
  if (a.startsWith('pfd-')) {
    const idx = +a.slice(4);
    socket.emit('play-face-down', { index: idx });
    return;
  }

  // Game over: play again
  if (a === 'ng') { socket.emit('play-again'); return; }
});

// ── Rendering ────────────────────────────────────────────────────────────────
function render(state) {
  renderStatusBar(state);
  renderOpponentPanel(state);
  renderPiles(state);
  renderPlayerPanel(state);
  renderBtns(state);

  if (state.phase === 'playing' || state.phase === 'setup') {
    gameOverOverlay.classList.add('hidden');
    disconnectOverlay.classList.add('hidden');
  }
  if (state.phase === 'over') showGameOver(state);
}

function renderStatusBar(state) {
  statusMsg.innerHTML = state.lastAction || '';
  if (state.u7) statusMsg.innerHTML += ' <span class="u7-badge">must play ≤ 7</span>';

  if (state.phase === 'setup') {
    turnIndicator.className = 'setup';
    turnIndicator.textContent = state.ready[state.yourIndex] ? 'Waiting for opponent...' : 'Swap cards';
  } else if (state.phase === 'over') {
    turnIndicator.className = 'their-turn';
    turnIndicator.textContent = 'Game over';
  } else if (state.isYourTurn) {
    turnIndicator.className = 'your-turn';
    turnIndicator.textContent = state.source === 'fd' ? 'Flip a face-down!' : 'Your turn';
  } else {
    turnIndicator.className = 'their-turn';
    turnIndicator.textContent = `${state.opponentName}'s turn`;
  }
}

function renderOpponentPanel(state) {
  opponentPanel.innerHTML = '';

  // Opponent hand fan (card backs)
  if (state.opponentHandCount > 0) {
    const fan = document.createElement('div');
    fan.className = 'opp-fan';
    for (let i = 0; i < state.opponentHandCount; i++) {
      const c = document.createElement('div');
      c.className = 'card fd';
      c.style.position = 'relative';
      fan.appendChild(c);
    }
    opponentPanel.appendChild(fan);
  }

  // Stacked positions: fd behind, fu in front
  const sr = document.createElement('div');
  sr.className = 'stack-row';
  for (let i = 0; i < 3; i++) {
    const pos = document.createElement('div');
    pos.className = 'stk';
    if (i < state.opponentFaceDownCount) {
      const c = document.createElement('div');
      c.className = 'card fd';
      c.style.cssText = 'position:absolute;top:0;left:0;z-index:0;';
      pos.appendChild(c);
    } else {
      const s = mkSlot();
      s.style.cssText = 'position:absolute;top:0;left:0;';
      pos.appendChild(s);
    }
    const fuCard = state.opponentFaceUp[i];
    if (fuCard) {
      const c = mkCard(fuCard, false);
      c.style.cssText = `position:absolute;top:${i < state.opponentFaceDownCount ? '20px' : '0'};left:0;z-index:1;`;
      pos.appendChild(c);
    }
    sr.appendChild(pos);
  }
  opponentPanel.appendChild(sr);
}

function renderPlayerPanel(state) {
  playerPanel.innerHTML = '';
  const pTurn = state.isYourTurn;
  const isSetup = state.phase === 'setup';
  const isOver = state.phase === 'over';

  // Stacked positions: fd behind, fu in front
  const sr = document.createElement('div');
  sr.className = 'stack-row';
  for (let i = 0; i < 3; i++) {
    const pos = document.createElement('div');
    pos.className = 'stk';
    const hasFd = i < state.faceDownCount;
    const fuCard = state.faceUp[i];
    const fdActive = state.source === 'fd' && pTurn;
    const fuActive = state.source === 'fu' && pTurn;

    if (hasFd) {
      const c = document.createElement('div');
      c.className = 'card fd';
      c.style.cssText = 'position:absolute;top:0;left:0;z-index:0;';
      if (state.source !== 'fd' && !isSetup) c.classList.add('dim');
      if (fdActive) setAct(c, `pfd-${i}`);
      pos.appendChild(c);
    } else {
      const s = mkSlot();
      s.style.cssText = 'position:absolute;top:0;left:0;';
      pos.appendChild(s);
    }

    if (fuCard) {
      const c = mkCard(fuCard, false);
      c.style.cssText = `position:absolute;top:${hasFd ? '20px' : '0'};left:0;z-index:1;`;
      if (isSetup) {
        setAct(c, `sfu-${fuCard.id}`);
        if (swapCard !== null) c.style.outline = '2px solid #5cb85c';
      } else {
        if (selectedCards.has(fuCard.id)) c.classList.add('sel');
        if (state.source !== 'fu' && !isOver) c.classList.add('dim');
        if (fuActive) setAct(c, `pfu-${fuCard.id}`);
      }
      pos.appendChild(c);
    }
    sr.appendChild(pos);
  }
  playerPanel.appendChild(sr);

  // Hand cards — fan overlap when too many to fit in one row
  const hr = document.createElement('div');
  hr.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:nowrap;padding-top:14px;align-items:flex-end;overflow:visible;min-height:calc(var(--ch) + 18px);';

  const handCards = state.hand;
  const n = handCards.length;

  // Compute overlap: read actual card width from an already-rendered card
  let overlapPx = 0;
  if (n > 1) {
    const sampleCard = playerPanel.querySelector('.card');
    const cw = sampleCard ? sampleCard.offsetWidth : 72;
    const gameW = gameEl.offsetWidth || document.body.offsetWidth;
    const maxW = Math.min(gameW - 20, 900);
    const naturalW = cw * n + 6 * (n - 1);
    if (naturalW > maxW) {
      const minPeek = Math.max(20, cw * 0.28);
      const peek = Math.max(minPeek, (maxW - cw) / (n - 1));
      overlapPx = Math.max(0, cw - peek);
    }
  }

  if (isSetup) {
    handCards.forEach((card, i) => {
      const c = mkCard(card, false);
      c.style.position = 'relative';
      c.style.flexShrink = '0';
      c.style.zIndex = i;
      if (overlapPx > 0 && i < n - 1) c.style.marginRight = `-${overlapPx}px`;
      setAct(c, `sh-${card.id}`);
      if (swapCard === card.id) c.classList.add('sel');
      hr.appendChild(c);
    });
  } else {
    handCards.forEach((card, i) => {
      const c = mkCard(card, false);
      c.style.position = 'relative';
      c.style.flexShrink = '0';
      c.style.zIndex = i;
      if (overlapPx > 0 && i < n - 1) c.style.marginRight = `-${overlapPx}px`;
      if (selectedCards.has(card.id)) c.classList.add('sel');
      if (state.source === 'h' && pTurn && !canPlay(card, state.pileTop, state.pileSecond, state.pileCount, state.u7)) {
        c.classList.add('dim');
      }
      if (state.source === 'h' && pTurn) setAct(c, `ph-${card.id}`);
      hr.appendChild(c);
    });
    if (!state.hand.length && state.source === 'h') {
      const sp = document.createElement('span');
      sp.style.cssText = 'font-size:12px;color:#555;padding:4px 10px;';
      sp.textContent = '—';
      hr.appendChild(sp);
    }
  }
  playerPanel.appendChild(hr);
}

function renderPiles(state) {
  const dp = document.getElementById('draw-pile');
  dp.innerHTML = '';
  document.getElementById('draw-lbl').textContent = `DRAW \u00B7 ${state.drawCount}`;
  if (state.drawCount) {
    const c = document.createElement('div');
    c.className = 'card fd';
    c.style.cssText = 'position:absolute;top:0;left:0;';
    dp.appendChild(c);
  } else {
    const s = mkSlot();
    s.style.cssText = 'position:absolute;top:0;left:0;';
    dp.appendChild(s);
  }

  const pp = document.getElementById('play-pile');
  // Preserve burning class
  const wasBurning = pp.classList.contains('burning');
  pp.innerHTML = '';
  if (wasBurning) pp.classList.add('burning');
  document.getElementById('pile-lbl').textContent = `PILE \u00B7 ${state.pileCount}`;
  if (state.pileTop) {
    if (state.pileSecond) {
      const c2 = mkCard(state.pileSecond, false);
      c2.style.cssText = 'position:absolute;top:0;left:-5px;z-index:0;opacity:.55;';
      pp.appendChild(c2);
    }
    const ct = mkCard(state.pileTop, false);
    ct.style.cssText = 'position:absolute;top:0;left:0;z-index:1;';
    pp.appendChild(ct);
  } else {
    const s = mkSlot();
    s.style.cssText = 'position:absolute;top:0;left:0;';
    pp.appendChild(s);
  }
}

function renderBtns(state) {
  btnsEl.innerHTML = '';
  const mk = (txt, a, cls) => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (cls || '');
    btn.dataset.a = a;
    btn.textContent = txt;
    btnsEl.appendChild(btn);
    return btn;
  };

  if (state.phase === 'setup') {
    const rb = mk('Ready', 'ready', 'ready-btn');
    if (state.ready[state.yourIndex]) rb.disabled = true;
  } else if (state.phase === 'playing') {
    if (state.source !== 'fd') {
      const cards = state.source === 'h' ? state.hand : state.faceUp;
      const hasValid = cards.some(c => canPlay(c, state.pileTop, state.pileSecond, state.pileCount, state.u7));
      const pb = mk('Play selected', 'play', '');
      pb.disabled = !state.isYourTurn || !selectedCards.size;
      const ub = mk('Pick up pile', 'pup', 'outline');
      ub.disabled = !state.isYourTurn || hasValid || !state.pileCount;
    }
  } else if (state.phase === 'over') {
    mk('Play again', 'ng', '');
  }
}

function showGameOver(state) {
  gameOverOverlay.classList.remove('hidden');
  if (state.winner === state.yourIndex) {
    gameOverTitle.className = 'win';
    gameOverTitle.textContent = 'You Win!';
    gameOverSubtitle.textContent = `${state.opponentName} is the shithead!`;
  } else {
    gameOverTitle.className = 'lose';
    gameOverTitle.textContent = 'You Lose';
    gameOverSubtitle.textContent = `You are the shithead!`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function showGame() { lobbyEl.classList.add('hidden'); gameEl.classList.remove('hidden'); }

function clearSession() { storedRoom = null; inGame = false; currentState = null; selectedCards = new Set(); swapCard = null; }

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

function showLobbyError(msg) { lobbyError.textContent = msg; lobbyError.classList.remove('hidden'); }
function clearLobbyError() { lobbyError.textContent = ''; lobbyError.classList.add('hidden'); }
