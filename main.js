import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

WebAppKit.init({ title: 'NOCCA*NOCCA', text: '縦横斜めに1マス動かし、相手の奥へ駒を進めたら勝ちの2人対戦ボードゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前にこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let audioCtx = null;
// 駒を置く音（短い木の音）。win なら高めの 3 音
function beep(win) {
  try {
    setAudioSession(true);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = win ? [523, 659, 784] : [300];
    notes.forEach((f, k) => {
      const t = audioCtx.currentTime + k * 0.12;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (win ? 0.3 : 0.08));
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.35);
    });
  } catch { /* 音が出なくても遊べる */ }
}

// ---- ここからアプリ本体 ----
//
// NOCCA*NOCCA: 横 5 × 縦 6 マスの盤。各マスは駒の山（配列、下から上。最大 3 段）。
// プレイヤー 1（先手）は row0 側に並び、row が増える向きに進む。row5 のさらに奥（row6）が 1 のゴール。
// プレイヤー 2（後手）は row5 側に並び、row が減る向きに進む。row0 のさらに手前（row-1）が 2 のゴール。
// 手番では自分の色が一番上に乗っている山を 1 つ選び、8 方向のどれかへ 1 マス動かす
// （山の上に乗る＝積む。3 段の山には乗れない。自分のゴール側の外には出られない）。
// 動かせる駒が 1 つもなければその場で負け。

const COLS = 5, ROWS = 6;
const idx = (r, c) => r * COLS + c;
const rowOf = (i) => (i / COLS) | 0;
const colOf = (i) => i % COLS;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function initialBoard() {
  const board = Array.from({ length: COLS * ROWS }, () => []);
  for (let c = 0; c < COLS; c++) { board[idx(0, c)] = [1]; board[idx(ROWS - 1, c)] = [2]; }
  return board;
}
function topColor(stack) { return stack.length ? stack[stack.length - 1] : 0; }

// そのプレイヤーが選べる駒ごとに、動ける先（通常のマス、またはゴール）を返す
function legalMoves(board, player) {
  const moves = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const from = idx(r, c);
      if (topColor(board[from]) !== player) continue;
      for (const [dr, dc] of DIRS) {
        const nc = c + dc;
        if (nc < 0 || nc >= COLS) continue; // 左右の外にはゴールがない
        const nr = r + dr;
        if (nr < 0) { if (player === 2) moves.push({ from, exit: true }); continue; } // player1 は自分のゴール側で出られない
        if (nr >= ROWS) { if (player === 1) moves.push({ from, exit: true }); continue; } // player2 は自分のゴール側で出られない
        const to = idx(nr, nc);
        if (board[to].length < 3) moves.push({ from, to });
      }
    }
  }
  return moves;
}
function other(p) { return p === 1 ? 2 : 1; }

// ---- CPU（簡単な先読み + αβ 枝刈り） ----
const SEARCH_PLIES = 3; // この手を含め 3 手先まで読む
const WIN_SCORE = 1e6;
function evaluate(board, cpu) {
  let score = 0;
  for (let i = 0; i < board.length; i++) {
    const r = rowOf(i);
    for (const color of board[i]) {
      const progress = color === 1 ? r : ROWS - 1 - r; // ゴールに近いほど大きい
      score += (color === cpu ? 1 : -1) * progress;
    }
  }
  return score;
}
function search(board, player, depth, cpu, alpha, beta) {
  const moves = legalMoves(board, player);
  if (moves.length === 0) return player === cpu ? -WIN_SCORE : WIN_SCORE; // 動けない方の負け
  if (moves.some((m) => m.exit)) return player === cpu ? WIN_SCORE : -WIN_SCORE; // 動く側がそのまま勝つ
  if (depth === 0) return evaluate(board, cpu);
  const maximizing = player === cpu;
  let best = maximizing ? -Infinity : Infinity;
  for (const mv of moves) {
    const nb = board.map((s) => s.slice());
    nb[mv.to].push(nb[mv.from].pop());
    const val = search(nb, other(player), depth - 1, cpu, alpha, beta);
    if (maximizing) { best = Math.max(best, val); alpha = Math.max(alpha, val); }
    else { best = Math.min(best, val); beta = Math.min(beta, val); }
    if (beta <= alpha) break;
  }
  return best;
}
function chooseCpuMove(board, player) {
  const moves = legalMoves(board, player);
  const exitMove = moves.find((m) => m.exit);
  if (exitMove) return exitMove; // 勝てるならすぐ勝つ
  let bestVal = -Infinity, bests = [];
  for (const mv of moves) {
    const nb = board.map((s) => s.slice());
    nb[mv.to].push(nb[mv.from].pop());
    const val = search(nb, other(player), SEARCH_PLIES - 1, player, -Infinity, Infinity);
    if (val > bestVal) { bestVal = val; bests = [mv]; } else if (val === bestVal) bests.push(mv);
  }
  return bests[(Math.random() * bests.length) | 0];
}

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面
let thinking = false;

function newGame(mode) {
  G = { mode, board: initialBoard(), turn: 1, winner: null, sel: null };
  thinking = false;
  render();
  maybeCpuTurn();
}
function playerLabel(p) {
  if (G.mode === 'cpu') return p === 1 ? 'あなた' : 'CPU';
  return p === 1 ? '1人目' : '2人目';
}
function isCpuTurn() { return G.mode === 'cpu' && G.turn === 2; }
function canInteract() { return !G.winner && !thinking && !isCpuTurn(); }

function applyMove(mv) {
  const mover = G.turn;
  if (mv.exit) {
    G.board[mv.from] = G.board[mv.from].slice(0, -1); // 盤からは消える（ゴールへ出た）
    G.winner = mover;
  } else {
    G.board[mv.to].push(G.board[mv.from].pop());
    G.turn = other(mover);
    if (legalMoves(G.board, G.turn).length === 0) G.winner = mover; // 次の人が動けない
  }
  beep(!!G.winner);
  G.sel = null;
  render();
  maybeCpuTurn();
}

function onCellTap(i) {
  if (!canInteract()) return;
  if (G.sel == null) {
    if (topColor(G.board[i]) !== G.turn) return;
    G.sel = i;
    render();
    return;
  }
  if (i === G.sel) { G.sel = null; render(); return; }
  if (topColor(G.board[i]) === G.turn) { G.sel = i; render(); return; } // 選び直し
  const moves = legalMoves(G.board, G.turn).filter((m) => m.from === G.sel && !m.exit);
  const mv = moves.find((m) => m.to === i);
  if (mv) applyMove(mv);
}
function onGoalTap(forPlayer) {
  if (!canInteract() || G.sel == null || forPlayer !== G.turn) return;
  const mv = legalMoves(G.board, G.turn).find((m) => m.from === G.sel && m.exit);
  if (mv) applyMove(mv);
}

function maybeCpuTurn() {
  if (!G || G.winner || !isCpuTurn()) return;
  thinking = true;
  render();
  const game = G;
  setTimeout(() => {
    if (G !== game) return;
    const mv = chooseCpuMove(G.board, G.turn);
    thinking = false;
    applyMove(mv);
  }, 300);
}

// ---- 3D の盤（three.js）。qawale と同じ木の質感 ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 7, 6.6);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 16;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN = woodTexture();
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const BOARD_W = COLS + 0.8, BOARD_D = ROWS + 0.8;
const board = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 0.36, BOARD_D), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

// ---- 机の天板。盤の下に木の板を敷き、ランプに照らされたようにふちを背景へ溶かす ----
{
  const w = Math.max(BOARD_W, BOARD_D);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) {
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2);
    }
  });
  const r = S / 2, inner = (w * 0.62) / (w * 3.2);
  const lamp = g.createRadialGradient(r, r, 0, r, r, r);
  lamp.addColorStop(0, '#000'); lamp.addColorStop(inner, 'rgba(0, 0, 0, 0.9)'); lamp.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = lamp; g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  const shade = g.createRadialGradient(r, r, 0, r, r, r * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = shade; g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const table = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.18 - 0.18 - 0.01;
  table.renderOrder = -1;
  scene.add(table);
}

// ホーム画面では盤をゆっくり回して見せる。対局に入ったら最初の向きに戻す
{
  const HOME_CAM = camera.position.clone();
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let wasHome = false;
  controls.autoRotateSpeed = 0.6;
  const spin = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title');
    controls.autoRotate = home && !still.matches;
    if (controls.autoRotate) controls.update();
    else if (wasHome && !home) { camera.position.copy(HOME_CAM); controls.update(); }
    wasHome = home;
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
}

function cellX(i) { return colOf(i) - (COLS - 1) / 2; }
function cellZ(i) { return rowOf(i) - (ROWS - 1) / 2; }
// ゴールの帯の位置（奥へ 1 マス分）
const GOAL_Z = { 1: cellZ(idx(ROWS - 1, 0)) + 1, 2: cellZ(idx(0, 0)) - 1 };

const CELL_BASE = [0x4a2e1c, 0x3d2516]; // 市松に濃淡
const cellGeo = new THREE.BoxGeometry(0.94, 0.03, 0.94);
const cellMeshes = [...Array(COLS * ROWS).keys()].map((i) => {
  const shade = (rowOf(i) + colOf(i)) % 2;
  const m = new THREE.Mesh(cellGeo, wood(CELL_BASE[shade], { roughness: 0.7, clearcoat: 0 }));
  m.position.set(cellX(i), 0.016, cellZ(i));
  m.userData.cell = i;
  scene.add(m);
  return m;
});
// ゴールの帯（手前・奥の外側）
const goalGeo = new THREE.BoxGeometry(BOARD_W - 0.1, 0.03, 0.8);
const goalMat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28 });
const GOAL_COLOR = { 1: 0xead3a8, 2: 0x5a3820 };
const goalMeshes = {};
for (const p of [1, 2]) {
  const m = new THREE.Mesh(goalGeo, goalMat(GOAL_COLOR[p]));
  m.position.set(0, 0.016, GOAL_Z[p]);
  m.userData.goal = p;
  m.visible = false;
  scene.add(m);
  goalMeshes[p] = m;
}

// 石：先手・後手は qawale と同じ明るい木・暗い木の円柱
const CHIP_H = 0.2, CHIP_R = 0.34;
const CHIP_GEO = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 32);
const CHIP_MAT = { 1: wood(0xead3a8), 2: wood(0x5a3820) };
function chipMesh(color) { return new THREE.Mesh(CHIP_GEO, CHIP_MAT[color]); }

// 選べる・動ける・いま選んでいる、の強調は床に薄いリングを重ねて出す
const ringGeo = new THREE.RingGeometry(0.3, 0.38, 36);
function ringMat(color, opacity) { return new THREE.MeshBasicMaterial({ color, transparent: true, opacity }); }
const RING_STYLE = {
  pickable: ringMat(0xffd35c, 0.3),
  legal: ringMat(0xffd35c, 0.85),
  cur: ringMat(0xffffff, 0.8),
};
function highlightMesh(kind, i) {
  const m = new THREE.Mesh(ringGeo, RING_STYLE[kind]);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cellX(i), 0.02, cellZ(i));
  return m;
}
function cellHighlight(i) {
  if (!G) return null;
  if (G.sel === i) return 'cur';
  if (G.sel != null && canInteract()) {
    const moves = legalMoves(G.board, G.turn).filter((m) => m.from === G.sel && !m.exit);
    if (moves.some((m) => m.to === i)) return 'legal';
  }
  if (G.sel == null && canInteract() && topColor(G.board[i]) === G.turn) return 'pickable';
  return null;
}

let pieceGroup = new THREE.Group();
scene.add(pieceGroup);
function syncScene(b = G ? G.board : DEMO) {
  scene.remove(pieceGroup);
  pieceGroup = new THREE.Group();
  b.forEach((stack, i) => {
    stack.forEach((color, h) => {
      const m = chipMesh(color);
      m.position.set(cellX(i), h * CHIP_H, cellZ(i));
      pieceGroup.add(m);
    });
    const kind = cellHighlight(i);
    if (kind) pieceGroup.add(highlightMesh(kind, i));
  });
  scene.add(pieceGroup);
  for (const p of [1, 2]) {
    const canExit = !!G && G.sel != null && canInteract() && legalMoves(G.board, G.turn).some((m) => m.from === G.sel && m.exit && G.turn === p);
    goalMeshes[p].visible = canExit;
  }
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!G) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...cellMeshes, ...Object.values(goalMeshes), pieceGroup], true)[0];
  if (!hit) return;
  if (hit.object.userData.goal != null) onGoalTap(hit.object.userData.goal);
  else if (hit.object.userData.cell != null) onCellTap(hit.object.userData.cell);
});

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) {
    stage.innerHTML = titleHTML();
    document.getElementById('board3d').appendChild(canvas);
    syncScene(DEMO);
    bindTitle();
    return;
  }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

// タイトル画面に出す見本の局面（中盤）
const DEMO = (() => {
  const b = initialBoard();
  b[idx(1, 1)] = [1]; b[idx(0, 1)] = [];
  b[idx(2, 3)] = [1, 2]; b[idx(5, 3)] = [];
  b[idx(4, 2)] = [2]; b[idx(5, 2)] = [];
  return b;
})();

function titleHTML() {
  return `
    <div class="title">
      <h2>NOCCA*NOCCA</h2>
      <p class="hint">自分の駒を縦横斜めに1マス動かす。駒の上に乗ってもよい（3段まで）。相手側の奥の列からさらに奥（ゴール）へ進めたら勝ち。</p>
      <div class="board3d" id="board3d"></div>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
    </div>`;
}
function bindTitle() {
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.start)));
}

function statusText() {
  if (thinking) return 'CPU が考え中…';
  if (G.winner) return `${playerLabel(G.winner)} の勝ち！`;
  return `${playerLabel(G.turn)} の番：${G.sel == null ? '動かす駒をえらぶ' : '行き先をえらぶ'}`;
}
function gameHTML() {
  const handsRow = `
    <div class="hands">
      <span class="hands__p${G.turn === 1 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--a"></span>${playerLabel(1)}</span>
      <span class="hands__p${G.turn === 2 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--b"></span>${playerLabel(2)}</span>
    </div>`;
  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';
  return `
    <div class="game">
      <p class="status">${statusText()}</p>
      ${handsRow}
      <div class="board3d${thinking ? ' board3d--busy' : ''}" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      ${G.winner ? '' : '<button class="pill game__home" data-title>ホームに戻る</button>'}
      ${again}
    </div>`;
}
function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => {
    if (!G.winner && confirm('対局をやめてホームに戻りますか？') === false) return;
    G = null;
    thinking = false;
    render();
  });
}

render();
