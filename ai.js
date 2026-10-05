// NOCCA*NOCCA の CPU（Web Worker）。negamax + αβ + 反復深化 + 置換表 + Zobrist ハッシュ（最強のみ）。
// ルール（legalMoves の中身）は main.js と完全に同じにすること。
// 盤は main.js と同じく「マスごとの山（配列、下から上）」の形でやり取りするが、
// 探索中は複製せず、グローバルな stacks/heights を make/unmake しながら使う
// （Worker は 1 手につき 1 回しか bestMove を呼ばないので安全）。

const COLS = 5, ROWS = 6, CELLS = COLS * ROWS, CAP = 3; // 1 マス最大 3 段
const idx = (r, c) => r * COLS + c;
const rowOf = (i) => (i / COLS) | 0;
const colOf = (i) => i % COLS;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const other = (p) => (p === 1 ? 2 : 1);
const WIN = 100000;
const TIMEOUT = {};

const stacks = new Uint8Array(CELLS * CAP);
const heights = new Uint8Array(CELLS);

function rnd32() { return (Math.random() * 0x100000000) >>> 0; }
// Zobrist: マス × 段 × 色ごとに 32bit を 2 本（衝突を減らす）。手番の違いは別キーで混ぜる。
const ZA = new Uint32Array(CELLS * CAP * 3); // 色は 1 か 2 だが枠は 3 用意（0 は使わない）
const ZB = new Uint32Array(CELLS * CAP * 3);
for (let i = 0; i < ZA.length; i++) { ZA[i] = rnd32(); ZB[i] = rnd32(); }
const TURN_A = [0, rnd32(), rnd32()], TURN_B = [0, rnd32(), rnd32()]; // turn=1,2 用
function zIdx(cell, level, color) { return (cell * CAP + level) * 3 + color; }

let hashA = 0, hashB = 0;

function topColor(cell) { const h = heights[cell]; return h ? stacks[cell * CAP + h - 1] : 0; }
function pushStone(cell, color) {
  const l = heights[cell];
  stacks[cell * CAP + l] = color;
  heights[cell] = l + 1;
  const zi = zIdx(cell, l, color);
  hashA = (hashA ^ ZA[zi]) >>> 0; hashB = (hashB ^ ZB[zi]) >>> 0;
}
function popStone(cell) {
  const l = heights[cell] - 1;
  const color = stacks[cell * CAP + l];
  const zi = zIdx(cell, l, color);
  hashA = (hashA ^ ZA[zi]) >>> 0; hashB = (hashB ^ ZB[zi]) >>> 0;
  heights[cell] = l;
  return color;
}
// main.js の「マスごとの配列」表現を読み込み、内部状態（高さ・ハッシュ）を作る。
function loadBoard(board) {
  heights.fill(0); hashA = 0; hashB = 0;
  for (let c = 0; c < CELLS; c++) {
    const st = board[c];
    for (let l = 0; l < st.length; l++) pushStone(c, st[l]);
  }
}

// 1 手: from の一番上を to へ移す（to===null は自分のゴールへ出る＝盤から消える）
function doMove(mv) {
  const color = popStone(mv.from);
  if (!mv.exit) pushStone(mv.to, color);
  return color;
}
function undoMove(mv, color) {
  if (!mv.exit) popStone(mv.to);
  pushStone(mv.from, color);
}

// main.js の legalMoves と同じ規則（8 方向 1 マス、3 段まで、自分のゴール側だけ外へ出られる）。
function genMoves(player) {
  const moves = [];
  for (let i = 0; i < CELLS; i++) {
    if (topColor(i) !== player) continue;
    const r = rowOf(i), c = colOf(i);
    for (const [dr, dc] of DIRS) {
      const nc = c + dc;
      if (nc < 0 || nc >= COLS) continue;
      const nr = r + dr;
      if (nr < 0) { if (player === 2) moves.push({ from: i, exit: true }); continue; }
      if (nr >= ROWS) { if (player === 1) moves.push({ from: i, exit: true }); continue; }
      const to = idx(nr, nc);
      if (heights[to] < CAP) moves.push({ from: i, to });
    }
  }
  return moves;
}

// 評価: 前進量（上に乗って隠れている駒は軽め）＋ 相手を押さえている駒 ＋ 動ける手の数。
// player から見た点（negamax なので、呼ぶ側が常に「自分の番」として渡す）。
const PIN_BONUS = 8;
const MOB_WEIGHT = 1;
function evaluate(player, mobility) {
  let score = 0;
  for (let i = 0; i < CELLS; i++) {
    const h = heights[i];
    if (!h) continue;
    const r = rowOf(i);
    for (let l = 0; l < h; l++) {
      const color = stacks[i * CAP + l];
      const adv = color === 1 ? r : ROWS - 1 - r; // ゴールに近いほど大きい
      const top = l === h - 1;
      const w = top ? 3 : 1; // 一番上の駒ほど実際に動かせるので重く見る
      score += (color === player ? 1 : -1) * adv * w;
      if (top && l > 0) {
        const below = stacks[i * CAP + l - 1];
        if (below !== color) score += (color === player ? 1 : -1) * PIN_BONUS; // 相手の上に乗って押さえている
      }
    }
  }
  score += mobility * MOB_WEIGHT;
  return score;
}

// --- 置換表（固定長の型付き配列。常に上書き＝深いほうを残す単純な方式） ---
const TT_BITS = 16;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttUsed = new Uint8Array(TT_SIZE);
const ttA = new Uint32Array(TT_SIZE);
const ttB = new Uint32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttValue = new Int32Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE); // 0 exact, 1 lower(β打ち切り), 2 upper(α以下)
const ttFrom = new Int8Array(TT_SIZE);
const ttTo = new Int8Array(TT_SIZE);
function ttIndex(a, b) { return (Math.imul(a | 0, 2654435761) ^ b) & TT_MASK; }
function ttStore(a, b, depth, value, flag, from, to) {
  const i = ttIndex(a, b);
  if (!ttUsed[i] || ttDepth[i] <= depth) {
    ttUsed[i] = 1; ttA[i] = a; ttB[i] = b; ttDepth[i] = depth;
    ttValue[i] = value; ttFlag[i] = flag; ttFrom[i] = from; ttTo[i] = to;
  }
}

// キラー手（各深さで β 打ち切りを起こした手を 1 つ覚え、並べ替えに使う）
const MAX_PLY = 40;
const killerFrom = new Int8Array(MAX_PLY).fill(-1);
const killerTo = new Int8Array(MAX_PLY).fill(-1);

// これまでに盤に出た局面（手番込みのハッシュ A → B）。同じ局面に戻る手を減点し、千日手で止まらないようにする。
const REPEAT_PENALTY = 50;
let seen = new Map();

let nodes = 0;
// player の番として最善手を探す（negamax + αβ）。盤はグローバルな stacks/heights を直接 make/unmake する。
function search(player, depth, alpha, beta, ply, deadline) {
  if ((++nodes & 511) === 0 && performance.now() > deadline) throw TIMEOUT;

  const ta = (hashA ^ TURN_A[player]) >>> 0, tb = (hashB ^ TURN_B[player]) >>> 0;
  if (ply > 0 && seen.get(ta) === tb) return { value: REPEAT_PENALTY, mv: null }; // 戻した側（親）が損をする

  const moves = genMoves(player);
  if (moves.length === 0) return { value: -(WIN - ply), mv: null }; // 動けない＝負け
  for (const mv of moves) { if (mv.exit) return { value: WIN - ply, mv }; } // 出られるならそれが最善

  const ti = ttIndex(ta, tb);
  let hintFrom = -1, hintTo = -1;
  if (ttUsed[ti] && ttA[ti] === ta && ttB[ti] === tb) {
    hintFrom = ttFrom[ti]; hintTo = ttTo[ti];
    if (ttDepth[ti] >= depth) {
      const v = ttValue[ti], f = ttFlag[ti];
      if (f === 0) return { value: v, mv: { from: hintFrom, to: hintTo } };
      if (f === 1 && v >= beta) return { value: v, mv: { from: hintFrom, to: hintTo } };
      if (f === 2 && v <= alpha) return { value: v, mv: { from: hintFrom, to: hintTo } };
    }
  }
  if (depth === 0) return { value: evaluate(player, moves.length), mv: null };

  // 並べ替え: 置換表の手 → キラー手 → 相手の山に乗る手（押さえにいく手） → ふつう
  for (const mv of moves) {
    const isTT = mv.from === hintFrom && (mv.to ?? -1) === hintTo;
    const isKiller = !isTT && ply < MAX_PLY && mv.from === killerFrom[ply] && (mv.to ?? -1) === killerTo[ply];
    const pin = !mv.exit && heights[mv.to] > 0 && topColor(mv.to) !== player;
    mv.rank = isTT ? 3 : isKiller ? 2 : pin ? 1 : 0;
  }
  moves.sort((a, b) => b.rank - a.rank);

  const a0 = alpha;
  const opp = other(player);
  let best = -Infinity, bestMv = null;
  for (const mv of moves) {
    const color = doMove(mv);
    const val = -search(opp, depth - 1, -beta, -alpha, ply + 1, deadline).value;
    undoMove(mv, color);
    if (val > best) { best = val; bestMv = mv; }
    if (val > alpha) alpha = val;
    if (alpha >= beta) {
      if (ply < MAX_PLY) { killerFrom[ply] = mv.from; killerTo[ply] = mv.to ?? -1; }
      break;
    }
  }
  if (bestMv) ttStore(ta, tb, depth, best, best <= a0 ? 2 : best >= beta ? 1 : 0, bestMv.from, bestMv.to ?? -1);
  return { value: best, mv: bestMv };
}

function toExternal(mv) { return mv.exit ? { from: mv.from, exit: true } : { from: mv.from, to: mv.to }; }

export function bestMove(board, player, strength, history = []) {
  nodes = 0;
  seen = new Map();
  for (const [b, turn] of history) {
    loadBoard(b);
    seen.set((hashA ^ TURN_A[turn]) >>> 0, (hashB ^ TURN_B[turn]) >>> 0);
  }
  loadBoard(board);
  const moves = genMoves(player);
  if (!moves.length) return null;
  const exitMove = moves.find((m) => m.exit);
  if (exitMove) return toExternal(exitMove); // 出られるならそれで勝ち
  const randomMove = () => moves[(Math.random() * moves.length) | 0];

  if (strength === 'weak') {
    if (Math.random() < 0.3) return toExternal(randomMove()); // ときどき完全にランダム
    const opp = other(player);
    const scored = moves.map((mv) => {
      const color = doMove(mv);
      const val = -evaluate(opp, genMoves(opp).length); // 1 手先の盤を軽く眺めるだけ（相手の返し手は読まない）
      undoMove(mv, color);
      return { mv, val };
    });
    scored.sort((a, b) => b.val - a.val);
    const top = scored.filter((s) => s.val >= scored[0].val - 15); // 僅差はまとめてランダムに選ぶ
    return toExternal(top[(Math.random() * top.length) | 0].mv);
  }

  killerFrom.fill(-1); killerTo.fill(-1);
  ttUsed.fill(0); // 減点は局の履歴しだいなので、前の手の置換表は使わない

  if (strength === 'mid') {
    const r = search(player, 3, -Infinity, Infinity, 0, performance.now() + 2000);
    return toExternal(r.mv || randomMove());
  }

  // 最強: 時間の許す限り反復深化
  const deadline = performance.now() + 1500;
  let best = null;
  for (let depth = 1; depth <= 40; depth++) {
    try {
      const r = search(player, depth, -Infinity, Infinity, 0, deadline);
      if (r.mv) best = r;
      if (r.mv && Math.abs(r.value) >= WIN - 30) break; // 勝ち負けが確定
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
  return toExternal(best ? best.mv : randomMove());
}

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => {
    const { id, board, player, strength, history } = e.data;
    const mv = bestMove(board, player, strength, history);
    self.postMessage({ id, mv });
  };
}
