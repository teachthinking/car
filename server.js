const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));

const CANVAS_W = 800, CANVAS_H = 600;
const MAX_SENSOR_DIST = 300;

// ============================================================
// 🚦 紅綠燈系統
// ============================================================
const TRAFFIC_LIGHT_CYCLE = {
  green: 100,   // 100 ticks @ 50ms = 5 秒
  yellow: 30,   // 30 ticks = 1.5 秒
  red: 100      // 100 ticks = 5 秒
};

// 多房間管理
let rooms = {};

// ============================================================
// 輔助函數：隨機顏色
// ============================================================
function getRandomColor() {
  const colors = ['#e67e22', '#f1c40f', '#9b59b6', '#1abc9c', '#e74c3c', '#2980b9', '#16a085'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ============================================================
// 道路車道定義（靜態，供 NPC 生成使用）
// ============================================================
const ROAD_LANES = {
  hLanes: [
    { y: 60, dir: 1 },   // 往右→ 走下方車道
    { y: 35, dir: -1 },  // 往左← 走上方車道
    { y: 300, dir: 1 },
    { y: 275, dir: -1 },
    { y: 540, dir: 1 },
    { y: 515, dir: -1 },
  ],
  vLanes: [
    { x: 35, dir: 1 },   // 往下↓ 道路1左側
    { x: 65, dir: -1 },  // 往上↑ 道路1右側
    { x: 275, dir: 1 },
    { x: 305, dir: -1 },
    { x: 515, dir: 1 },
    { x: 545, dir: -1 },
    { x: 755, dir: 1 },
    { x: 785, dir: -1 },
  ]
};

// ============================================================
// 房間初始化（地圖 + NPC）
// ============================================================
function initializeRoom(room) {
  // 生成預設城市建築
  room.objects = [];
  room.events = [];
  room.eventObjects = []; // 固定型事件的矩形障礙（施工/車禍）
  room.goal = { x: 745, y: 490, w: 55, h: 80 };
  room.objects = [
    { type: 'building', x: 85, y: 85, w: 170, h: 170 },
    { type: 'park', x: 325, y: 85, w: 170, h: 170 },
    { type: 'building', x: 565, y: 85, w: 170, h: 170 },
    { type: 'park', x: 85, y: 325, w: 170, h: 170 },
    { type: 'building', x: 325, y: 325, w: 170, h: 170 },
    { type: 'park', x: 565, y: 325, w: 170, h: 170 },
    { type: 'parking', x: 740, y: 325, w: 55, h: 170 },
  ];

  // 生成紅綠燈
  const total = TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow + TRAFFIC_LIGHT_CYCLE.red;
  room.trafficLights = [
    { id: 0, cx: 50, cy: 290, dir: 'EW', timer: 0 },
    { id: 1, cx: 50, cy: 290, dir: 'NS', timer: TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
    { id: 2, cx: 290, cy: 290, dir: 'EW', timer: 20 },
    { id: 3, cx: 290, cy: 290, dir: 'NS', timer: 20 + TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
    { id: 4, cx: 530, cy: 290, dir: 'EW', timer: 40 },
    { id: 5, cx: 530, cy: 290, dir: 'NS', timer: 40 + TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
    { id: 6, cx: 50, cy: 530, dir: 'EW', timer: 10 },
    { id: 7, cx: 50, cy: 530, dir: 'NS', timer: 10 + TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
    { id: 8, cx: 290, cy: 530, dir: 'EW', timer: 30 },
    { id: 9, cx: 290, cy: 530, dir: 'NS', timer: 30 + TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
    { id: 10, cx: 530, cy: 530, dir: 'EW', timer: 50 },
    { id: 11, cx: 530, cy: 530, dir: 'NS', timer: 50 + TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow },
  ];

  // 初始 NPC 生成（車輛 + 行人）
  room.npcs = [];
  generateVehiclesForRoom(room);
  generatePedestriansForRoom(room, 8);
}

// 生成車輛 NPC
function generateVehiclesForRoom(room) {
  ROAD_LANES.hLanes.forEach(lane => {
    let startX = lane.dir > 0 ? -50 - Math.random() * 200 : 850 + Math.random() * 200;
    let speed = (1.2 + Math.random() * 1.2) * lane.dir;
    room.npcs.push({
      type: 'car',
      color: getRandomColor(),
      x: startX, y: lane.y,
      vx: speed, vy: 0,
      baseSpeed: speed,
      size: 22,
      laneY: lane.y,
      laneDir: lane.dir,
      stopForLight: false,
      stopForCar: false,
      slowTimer: 0
    });
  });

  ROAD_LANES.vLanes.forEach(lane => {
    let startY = lane.dir > 0 ? -50 - Math.random() * 200 : 650 + Math.random() * 200;
    let speed = (1.2 + Math.random() * 1.2) * lane.dir;
    room.npcs.push({
      type: 'car',
      color: getRandomColor(),
      x: lane.x, y: startY,
      vx: 0, vy: speed,
      baseSpeed: speed,
      size: 22,
      laneX: lane.x,
      laneDir: lane.dir,
      stopForLight: false,
      stopForCar: false,
      slowTimer: 0
    });
  });
}

// 生成行人 NPC
function generatePedestriansForRoom(room, count) {
  const pedestrianEmojis = ['🚶', '🏃‍♀️', '🚶‍♂️', '🧒', '👴', '🧍'];
  for (let i = 0; i < count; i++) {
    let pos = getSafePedestrianPos(room);
    room.npcs.push({
      type: 'pedestrian',
      emoji: pedestrianEmojis[i % pedestrianEmojis.length],
      x: pos.x, y: pos.y,
      vx: (Math.random() - 0.5) * 1.0,
      vy: (Math.random() - 0.5) * 1.0,
      size: 14,
      waitTimer: 0,
      crossing: false
    });
  }
}

// 取得安全的行人起始位置（避開道路）
function getSafePedestrianPos(room) {
  const sidewalkAreas = [
    { x: [80, 240], y: [80, 240] },
    { x: [320, 480], y: [80, 240] },
    { x: [560, 720], y: [80, 240] },
    { x: [80, 240], y: [320, 480] },
    { x: [320, 480], y: [320, 480] },
    { x: [560, 720], y: [320, 480] },
  ];
  for (let attempt = 0; attempt < 50; attempt++) {
    let area = sidewalkAreas[Math.floor(Math.random() * sidewalkAreas.length)];
    let x = area.x[0] + Math.random() * (area.x[1] - area.x[0]);
    let y = area.y[0] + Math.random() * (area.y[1] - area.y[0]);
    if (!isInsideObject(x, y, room.objects) && !isOnTrack(x, y, room.tracks)) return { x, y };
  }
  return { x: 150, y: 150 };
}

// ============================================================
// 碰撞/道路檢測函數（參數化）
// ============================================================
function isInsideObject(x, y, objects) {
  if (!objects) return false;
  for (let obj of objects) {
    if (obj.type === 'parking') continue;
    if (x > obj.x - 15 && x < obj.x + obj.w + 15 &&
      y > obj.y - 15 && y < obj.y + obj.h + 15) return true;
  }
  return false;
}

function isOnTrack(x, y, tracks) {
  if (!tracks) return false;
  for (let t of tracks) {
    if (t.isHoriz && Math.abs(y - t.y) < 30) return true;
    if (!t.isHoriz && Math.abs(x - t.x) < 30) return true;
  }
  return false;
}

// ============================================================
// 紅綠燈更新
// ============================================================
function updateTrafficLights(room) {
  const total = TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow + TRAFFIC_LIGHT_CYCLE.red;
  for (let tl of room.trafficLights) {
    tl.timer = (tl.timer + 1) % total;
    if (tl.timer < TRAFFIC_LIGHT_CYCLE.green) {
      tl.state = 'green';
    } else if (tl.timer < TRAFFIC_LIGHT_CYCLE.green + TRAFFIC_LIGHT_CYCLE.yellow) {
      tl.state = 'yellow';
    } else {
      tl.state = 'red';
    }
  }
}

// ============================================================
// 感測器光線投射（參數化）
// ============================================================
function castRay(x, y, angleDeg, objects, npcs, eventObjects) {
  const rad = angleDeg * Math.PI / 180;
  const dx = Math.cos(rad) * 4;
  const dy = Math.sin(rad) * 4;
  let cx = x, cy = y, dist = 0;
  while (dist < MAX_SENSOR_DIST) {
    cx += dx; cy += dy; dist += 4;
    if (cx < 0 || cx > CANVAS_W || cy < 0 || cy > CANVAS_H) return dist;
    for (let obj of objects) {
      if (obj.type === 'parking') continue;
      if (cx >= obj.x && cx <= obj.x + obj.w && cy >= obj.y && cy <= obj.y + obj.h) return dist;
    }
    for (let eo of (eventObjects || [])) {
      if (cx >= eo.x && cx <= eo.x + eo.w && cy >= eo.y && cy <= eo.y + eo.h) return dist;
    }
    for (let npc of npcs) {
      if (Math.hypot(cx - npc.x, cy - npc.y) < npc.size) return dist;
    }
  }
  return MAX_SENSOR_DIST;
}

// ============================================================
// AI 視覺辨識射線（感知 Perception & 預測 Prediction）
// ============================================================
function castVisionRay(x, y, angleDeg, objects, npcs, eventObjects) {
    const rad = angleDeg * Math.PI / 180;
    const dx = Math.cos(rad) * 4;
    const dy = Math.sin(rad) * 4;
    let cx = x, cy = y, dist = 0;
    
    while (dist < MAX_SENSOR_DIST) {
        cx += dx; cy += dy; dist += 4;
        
        // 碰到邊界
        if (cx < 0 || cx > CANVAS_W || cy < 0 || cy > CANVAS_H) return { type: 'wall', vx: 0, vy: 0 };
        
        // 碰到靜態建築或公園
        for (let obj of objects) {
            if (obj.type === 'parking') continue;
            if (cx >= obj.x && cx <= obj.x + obj.w && cy >= obj.y && cy <= obj.y + obj.h) {
                return { type: obj.type, vx: 0, vy: 0 };
            }
        }
        // 碰到施工區
        for (let eo of (eventObjects || [])) {
            if (cx >= eo.x && cx <= eo.x + eo.w && cy >= eo.y && cy <= eo.y + eo.h) return { type: 'construction', vx: 0, vy: 0 };
        }
        // 碰到動態物件 (行人 pedestrian 或 車輛 car)
        for (let npc of npcs) {
            if (Math.hypot(cx - npc.x, cy - npc.y) < npc.size) {
                return { type: npc.type, vx: npc.vx || 0, vy: npc.vy || 0 };
            }
        }
    }
    return { type: 'none', vx: 0, vy: 0 };
}

// ============================================================
// 紅綠燈判斷（參數化）
// ============================================================
function getTrafficLightAhead(npc, trafficLights) {
  let npcDir = '';
  if (npc.laneY !== undefined) {
    npcDir = npc.laneDir > 0 ? 'right' : 'left';
  } else if (npc.laneX !== undefined) {
    npcDir = npc.laneDir > 0 ? 'down' : 'up';
  } else return false;

  const STOP_DIST = 65;
  const STOP_GAP = 28;

  for (let tl of trafficLights) {
    if (tl.dir === 'EW' && (npcDir === 'right' || npcDir === 'left')) {
      let distToStop = npcDir === 'right'
        ? (tl.cx - STOP_GAP) - npc.x
        : npc.x - (tl.cx + STOP_GAP);
      if (distToStop > 0 && distToStop < STOP_DIST) {
        if (Math.abs(npc.y - tl.cy) > 60) continue;
        if (tl.state === 'red' || tl.state === 'yellow') return true;
      }
    }
    if (tl.dir === 'NS' && (npcDir === 'down' || npcDir === 'up')) {
      let distToStop = npcDir === 'down'
        ? (tl.cy - STOP_GAP) - npc.y
        : npc.y - (tl.cy + STOP_GAP);
      if (distToStop > 0 && distToStop < STOP_DIST) {
        if (Math.abs(npc.x - tl.cx) > 60) continue;
        if (tl.state === 'red' || tl.state === 'yellow') return true;
      }
    }
  }
  return false;
}

// ============================================================
// 取得或建立房間
// ============================================================
function getOrCreateRoom(roomId) {
  if (!roomId || typeof roomId !== 'string' || roomId.trim() === '') {
    roomId = "default";
  }
  if (!rooms[roomId]) {
    let newRoom = {
      roomId: roomId,
      active: true,
      objects: [],
      tracks: [],
      goal: { x: 745, y: 490, w: 55, h: 80 },
      startPoint: { x: 60, y: 60, angle: 0 },
      players: {},
      npcs: [],
      trafficLights: [],
      eventObjects: [],
      tick: 0
    };
    initializeRoom(newRoom);
    rooms[roomId] = newRoom;
  }
  return rooms[roomId];
}

// ============================================================
// 重置房間內所有學員車輛至起點
// ============================================================
function resetAllPlayersInRoom(room) {
  for (let pid in room.players) {
    let p = room.players[pid];
    p.x = room.startPoint.x;
    p.y = room.startPoint.y;
    p.angle = room.startPoint.angle;
    p.speed = 0;
    p.steering = 0;
    p.crashes = 0;
    p.eventPenalties = 0;
    p.finished = false;
  }
}

// ============================================================
// Socket.IO 連線處理（合併為單一區塊）
// ============================================================
io.on('connection', (socket) => {
  console.log('新連線:', socket.id);

  // 學員加入房間
  socket.on('student_join', (data) => {
    socket.join(data.room);
    socket.roomId = data.room;
    socket.studentId = data.id; // 記錄學號

    let currentRoom = getOrCreateRoom(data.room);

    // 初始化學員車輛
    currentRoom.players[data.id] = {
      id: data.id,
      x: currentRoom.startPoint.x,
      y: currentRoom.startPoint.y,
      angle: currentRoom.startPoint.angle,
      speed: 0,
      steering: 0,
      crashes: 0,
      eventPenalties: 0,
      finished: false
    };

    // 傳送地圖資料給該學員
    socket.emit('map', {
      objects: currentRoom.objects,
      goal: currentRoom.goal,
      tracks: currentRoom.tracks,
      trafficLights: currentRoom.trafficLights,
      events: currentRoom.events   // 新增
    });
  });

  // 教師加入房間
  socket.on('teacher_join', (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    // 可選：回傳房間現有狀態
    let room = getOrCreateRoom(roomId);
    socket.emit('teacher_room_state', {
      startPoint: room.startPoint,
      goal: room.goal,
      objects: room.objects,
      events: room.events
    });
  });

  // 教師部署設定（起點、終點）
  socket.on('deploy_settings', (data) => {
    let currentRoom = getOrCreateRoom(data.room);
    currentRoom.startPoint = data.startPoint;
    currentRoom.goal = data.goal;

    // 將房間內所有學員車輛重置到新起點
    resetAllPlayersInRoom(currentRoom);

    // 廣播更新給該房間所有學員
    io.to(data.room).emit('update_settings', {
      startPoint: data.startPoint,
      goal: data.goal
    });
  });

  // 教師全員重置
  socket.on('reset_all_students', (roomId) => {
    let currentRoom = getOrCreateRoom(roomId);
    resetAllPlayersInRoom(currentRoom);
    io.to(roomId).emit('force_stop_code');
  });

  // 教師更新地圖（新增/刪除建築物等）
  socket.on('updateMap', (mapData) => {
    if (!socket.roomId) return;
    let currentRoom = getOrCreateRoom(socket.roomId);
    currentRoom.objects = mapData.objects || [];
    currentRoom.goal = mapData.goal || currentRoom.goal;
    currentRoom.tracks = mapData.tracks || [];
    currentRoom.events = mapData.events || [];

    // 固定型事件（施工/車禍）轉為矩形障礙物
    // 施工區矩形：中心在 (evt.x+20, evt.y+20)，覆蓋整條雙向道路（寬 60px）
    // 施工區：找最近的單一車道，矩形精確覆蓋該車道（寬=車道寬約20px，長=60px）
    const H_LANES = [35, 60, 275, 300, 515, 540]; // 水平車道 y
    const V_LANES = [35, 65, 275, 305, 515, 545, 755, 785]; // 垂直車道 x
    currentRoom.eventObjects = (currentRoom.events || [])
      .filter(e => e.type === 'construction')
      .map(e => {
        const cx = e.x + 20, cy = e.y + 20;
        // 找最近水平車道
        let nearestH = H_LANES.reduce((a, b) => Math.abs(cy - a) < Math.abs(cy - b) ? a : b);
        // 找最近垂直車道
        let nearestV = V_LANES.reduce((a, b) => Math.abs(cx - a) < Math.abs(cx - b) ? a : b);
        let distH = Math.abs(cy - nearestH);
        let distV = Math.abs(cx - nearestV);
        if (distH < distV) {
          // 水平車道：矩形沿 x 方向延伸 60px，y 方向覆蓋車道寬 ±14px
          return { type: e.type, x: cx - 30, y: nearestH - 14, w: 60, h: 28, eventId: e.id, laneY: nearestH };
        } else {
          // 垂直車道：矩形沿 y 方向延伸 60px，x 方向覆蓋車道寬 ±14px
          return { type: e.type, x: nearestV - 14, y: cy - 30, w: 28, h: 60, eventId: e.id, laneX: nearestV };
        }
      });


    // 重新生成交通 NPC（保留事件 NPC，避免被清掉）
    currentRoom.npcs = currentRoom.npcs.filter(n => n.eventId); // 保留事件 NPC
    generateVehiclesForRoom(currentRoom);
    generatePedestriansForRoom(currentRoom, 8);
    // 同時重置事件冷卻，讓固定型事件立即重建
    currentRoom.eventCooldowns = {};

    // 廣播新地圖給該房間所有學員
    console.log(`[updateMap] 房間${socket.roomId} events:`, currentRoom.events);
    io.to(socket.roomId).emit('map', {
      objects: currentRoom.objects,
      goal: currentRoom.goal,
      tracks: currentRoom.tracks,
      trafficLights: currentRoom.trafficLights,
      events: currentRoom.events
    });
  });

  // 接收學員控制指令
  socket.on('cmd', (data) => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    let currentRoom = rooms[socket.roomId];
    let p = currentRoom.players[data.id];
    if (!p) return;
    if (data.action === 'motor') {
      p.speed = Number(data.val);
    } else if (data.action === 'steer') {
      p.steering = Number(data.val);
    }
  });

  // 強制移動特定學員（教師部署後個別調整）
  socket.on('force_move', (data) => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    let currentRoom = rooms[socket.roomId];
    let p = currentRoom.players[data.id];
    if (p) {
      p.x = data.x;
      p.y = data.y;
      p.angle = data.angle;
      p.speed = 0;
      p.steering = 0;
    }
  });

  // 斷線處理
  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      delete rooms[socket.roomId].players[socket.studentId];
    }
  });
  // 學生自行重置車輛
  socket.on('reset_self', () => {
    const roomId = socket.roomId;
    const studentId = socket.studentId;
    if (!roomId || !rooms[roomId]) return;
    const currentRoom = rooms[roomId];
    const player = currentRoom.players[studentId];
    if (!player) return;

    // 重置到房間起點
    player.x = currentRoom.startPoint.x;
    player.y = currentRoom.startPoint.y;
    player.angle = currentRoom.startPoint.angle;
    player.speed = 0;
    player.steering = 0;
    player.crashes = 0;
    player.eventPenalties = 0;
    player.finished = false;

    // 可選：通知該學生重置完成
    socket.emit('self_reset_confirmed');
  });
});

// ============================================================
// 主遊戲迴圈（50ms）
// ============================================================
setInterval(() => {
  for (let roomId in rooms) {
    let currentRoom = rooms[roomId];
    if (!currentRoom.active) continue;
    currentRoom.tick++;

    // 更新紅綠燈
    updateTrafficLights(currentRoom);
    // ── NPC life 計時（只有隨機型事件 NPC 有 life）──
    for (let i = currentRoom.npcs.length - 1; i >= 0; i--) {
      let npc = currentRoom.npcs[i];
      if (npc.life !== undefined) {
        npc.life--;
        if (npc.life <= 0) {
          if (npc.eventId) {
            if (!currentRoom.eventCooldowns) currentRoom.eventCooldowns = {};
            // 行人穿越：消失後冷卻 100~300 ticks（5~15 秒）
            currentRoom.eventCooldowns[npc.eventId] =
              100 + Math.floor(Math.random() * 200);
          }
          currentRoom.npcs.splice(i, 1);
          continue;
        }
      }
    }

    // ── 事件系統 ──
    // construction（施工）→ 永久固定障礙（單車道矩形）
    // pedestrian（行人穿越）→ 隨機出現、持續一段時間後消失、冷卻後再出現
    if (!currentRoom.eventCooldowns) currentRoom.eventCooldowns = {};

    if (currentRoom.events && currentRoom.events.length > 0) {
      // 行人冷卻倒數
      for (let eid in currentRoom.eventCooldowns) {
        if (currentRoom.eventCooldowns[eid] > 0) currentRoom.eventCooldowns[eid]--;
      }

      for (let evt of currentRoom.events) {
        // 施工已透過 eventObjects 矩形碰撞處理，這裡只處理行人
        if (evt.type !== 'pedestrian') continue;

        let existing = currentRoom.npcs.find(n => n.eventId === evt.id);
        if (existing) continue; // 已在場上
        if ((currentRoom.eventCooldowns[evt.id] || 0) > 0) continue; // 冷卻中
        if (Math.random() > 0.10) continue; // 每 tick 10% 機率出現（平均 0.5 秒）

        let lifespan = 100 + Math.floor(Math.random() * 100); // 5~10 秒
        console.log(`[行人事件] 房間 ${currentRoom.roomId} 事件 ${evt.id} 出現，存活 ${lifespan} ticks`);
        currentRoom.npcs.push({
          id: 'event_' + Date.now() + Math.random(),
          eventId: evt.id,
          type: 'event_pedestrian',
          x: evt.x + 20, y: evt.y + 20,
          vx: 0, vy: 0,
          size: 38,   // 覆蓋雙向2車道（約38px半徑）
          life: lifespan
        });
      }

      // 清除已被教師刪除的事件所對應的 NPC
      const validEventIds = new Set(currentRoom.events.map(e => e.id));
      currentRoom.npcs = currentRoom.npcs.filter(n =>
        !n.eventId || validEventIds.has(n.eventId)
      );
    } else {
      // 教師清空所有事件時，移除所有事件 NPC 與冷卻記錄
      currentRoom.npcs = currentRoom.npcs.filter(n => !n.eventId);
      currentRoom.eventCooldowns = {};
    }
    // 更新 NPC
    for (let i = 0; i < currentRoom.npcs.length; i++) {
      let npc = currentRoom.npcs[i];

      // 事件 NPC 是靜態障礙物，不需要移動邏輯
      if (npc.eventId) continue;

      // --- 行人邏輯 ---
      if (npc.type === 'pedestrian') {
        if (npc.waitTimer > 0) {
          npc.waitTimer--;
          continue;
        }

        let nextX = npc.x + npc.vx;
        let nextY = npc.y + npc.vy;
        let bounced = false;

        if (isInsideObject(nextX, nextY, currentRoom.objects) ||
          nextX < 10 || nextX > 790 || nextY < 10 || nextY > 590) {
          const angle = Math.atan2(npc.vy, npc.vx) + Math.PI + (Math.random() - 0.5) * 1.2;
          npc.vx = Math.cos(angle) * (0.6 + Math.random() * 0.5);
          npc.vy = Math.sin(angle) * (0.6 + Math.random() * 0.5);
          npc.waitTimer = 10 + Math.floor(Math.random() * 20);
          bounced = true;
        }

        let onRoad = isOnTrack(nextX, nextY, currentRoom.tracks);
        if (onRoad && Math.random() < 0.05) {
          npc.waitTimer = 5;
        }

        if (!bounced) {
          npc.x = nextX;
          npc.y = nextY;
        }

        if (currentRoom.tick % 80 === i % 80) {
          npc.vx += (Math.random() - 0.5) * 0.3;
          npc.vy += (Math.random() - 0.5) * 0.3;
          let spd = Math.hypot(npc.vx, npc.vy);
          if (spd > 1.2) { npc.vx *= 1.0 / spd; npc.vy *= 1.0 / spd; }
          if (spd < 0.3) { npc.vx *= 2; npc.vy *= 2; }
        }
        continue;
      }

      // --- 車輛邏輯 ---
      if (npc.type === 'car') {
        npc.stopForLight = getTrafficLightAhead(npc, currentRoom.trafficLights);

        // ── 施工區超車邏輯 ──
        // 對向車道映射（水平：相差25px，垂直：相差30px）
        const H_PAIR = {35:-1, 60:1, 275:-1, 300:1, 515:-1, 540:1}; // y→dir
        const H_OPP  = {35:60, 60:35, 275:300, 300:275, 515:540, 540:515}; // y→對向y
        const V_PAIR = {35:1, 65:-1, 275:1, 305:-1, 515:1, 545:-1, 755:1, 785:-1};
        const V_OPP  = {35:65, 65:35, 275:305, 305:275, 515:545, 545:515, 755:785, 785:755};

        // 偵測前方施工區（距離 80px 內）
        let constructionAhead = false;
        if (currentRoom.eventObjects && currentRoom.eventObjects.length > 0) {
          let dirX = npc.laneY !== undefined ? npc.laneDir : 0;
          let dirY = npc.laneX !== undefined ? npc.laneDir : 0;
          for (let eo of currentRoom.eventObjects) {
            let dx = (eo.x + eo.w/2) - npc.x;
            let dy = (eo.y + eo.h/2) - npc.y;
            let dot = dirX * dx + dirY * dy;
            let side = Math.abs(-dirY * dx + dirX * dy);
            if (dot > 0 && dot < 100 && side < 20) { constructionAhead = true; break; }
          }
        }

        // 超車狀態機：overtaking=true 表示正在走對向車道
        if (constructionAhead && !npc.overtaking) {
          // 切換到對向車道（保持原始行進方向 laneDir 不變）
          if (npc.laneY !== undefined && H_OPP[npc.laneY] !== undefined) {
            npc.origLaneY  = npc.laneY;
            npc.laneY      = H_OPP[npc.laneY];
            // laneDir 保持不變，繼續朝同方向行駛
            npc.overtaking = true;
            npc.overtakeClear = 0;
          } else if (npc.laneX !== undefined && V_OPP[npc.laneX] !== undefined) {
            npc.origLaneX  = npc.laneX;
            npc.laneX      = V_OPP[npc.laneX];
            // laneDir 保持不變
            npc.overtaking = true;
            npc.overtakeClear = 0;
          }
        }

        if (npc.overtaking) {
          // 前方不再有施工區：開始計時切回
          if (!constructionAhead) {
            npc.overtakeClear = (npc.overtakeClear || 0) + 1;
            if (npc.overtakeClear > 40) { // 40 ticks 後切回（2秒）
              if (npc.origLaneY !== undefined) {
                npc.laneY = npc.origLaneY;
                delete npc.origLaneY;
              } else if (npc.origLaneX !== undefined) {
                npc.laneX = npc.origLaneX;
                delete npc.origLaneX;
              }
              npc.overtaking = false;
              npc.overtakeClear = 0;
            }
          } else {
            npc.overtakeClear = 0; // 施工還在，重置計時
          }
        }

        // 前方有行人事件 NPC 時停車
        npc.stopForPedestrian = false;
        let npcDirXp = npc.laneY !== undefined ? npc.laneDir : 0;
        let npcDirYp = npc.laneX !== undefined ? npc.laneDir : 0;
        for (let en of currentRoom.npcs) {
          if (en.type !== 'event_pedestrian') continue;
          let dx = en.x - npc.x;
          let dy = en.y - npc.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 80) {
            let dot = npcDirXp * dx + npcDirYp * dy;
            let side = Math.abs(-npcDirYp * dx + npcDirXp * dy);
            if (dot > 0 && side < 35) { npc.stopForPedestrian = true; break; }
          }
        }

        npc.stopForCar = false;
        let npcDirX = npc.laneY !== undefined ? npc.laneDir : 0;
        let npcDirY = npc.laneX !== undefined ? npc.laneDir : 0;

        let allVehicles = [
          ...Object.values(currentRoom.players),
          ...currentRoom.npcs.filter(n => n !== npc && n.type === 'car')
        ];

        for (let other of allVehicles) {
          if (other.finished) continue;
          let dx = other.x - npc.x;
          let dy = other.y - npc.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 3) continue;
          if (dist < 70) {
            let dot = npcDirX * dx + npcDirY * dy;
            let sideDist = Math.abs(-npcDirY * dx + npcDirX * dy);
            if (dot > 0 && sideDist < 22) {
              npc.stopForCar = true;
              break;
            }
          }
        }

        if (npc.stopForLight || npc.stopForCar || npc.stopForPedestrian) {
          npc.vx = 0; npc.vy = 0;
        } else {
          let baseSpd = Math.abs(npc.baseSpeed);
          if (npc.laneY !== undefined) {
            npc.vx = baseSpd * npc.laneDir;
            npc.vy = (npc.laneY - npc.y) * 0.3;
            npc.y += (npc.laneY - npc.y) * 0.15;
          } else if (npc.laneX !== undefined) {
            npc.vy = baseSpd * npc.laneDir;
            npc.vx = (npc.laneX - npc.x) * 0.3;
            npc.x += (npc.laneX - npc.x) * 0.15;
          }

          let nextX = npc.x + npc.vx;
          let nextY = npc.y + npc.vy;
          if (!isInsideObject(nextX, nextY, currentRoom.objects)) {
            npc.x = nextX;
            npc.y = nextY;
          }

          if (npc.laneY !== undefined) {
            if (npc.laneDir > 0 && npc.x > 870) npc.x = -60;
            if (npc.laneDir < 0 && npc.x < -70) npc.x = 860;
          } else if (npc.laneX !== undefined) {
            if (npc.laneDir > 0 && npc.y > 670) npc.y = -60;
            if (npc.laneDir < 0 && npc.y < -70) npc.y = 660;
          }
        }
      }
    }

    // 更新玩家車輛
    for (let id in currentRoom.players) {
      let p = currentRoom.players[id];
      if (p.finished) continue;

      p.angle += p.steering;
      let rad = p.angle * Math.PI / 180;
      let nextX = p.x + Math.cos(rad) * p.speed;
      let nextY = p.y + Math.sin(rad) * p.speed;

      let hit = false;
      if (nextX < 0 || nextX > CANVAS_W || nextY < 0 || nextY > CANVAS_H) hit = true;

      for (let obj of currentRoom.objects) {
        if (obj.type === 'parking') continue;
        if (nextX > obj.x - 10 && nextX < obj.x + obj.w + 10 &&
          nextY > obj.y - 10 && nextY < obj.y + obj.h + 10) hit = true;
      }
      // 施工區：矩形碰撞，行進方向加車身邊界 12px，橫向不加（避免擋到對向車道）
      let hitConstruction = false;
      for (let eo of (currentRoom.eventObjects || [])) {
        let ex, ey, ew, eh;
        if (eo.laneY !== undefined) {
          // 水平車道：x 方向（行進）加 12，y 方向（橫向）不加
          ex = eo.x - 12; ew = eo.w + 24;
          ey = eo.y;      eh = eo.h;
        } else {
          // 垂直車道：y 方向（行進）加 12，x 方向（橫向）不加
          ex = eo.x;      ew = eo.w;
          ey = eo.y - 12; eh = eo.h + 24;
        }
        if (nextX > ex && nextX < ex + ew && nextY > ey && nextY < ey + eh) hitConstruction = true;
      }
      // DEBUG：每50 tick 印一次
      if (currentRoom.tick % 50 === 0 && Object.keys(currentRoom.players).length > 0) {
        console.log('[DEBUG] eventObjects:', JSON.stringify(currentRoom.eventObjects));
        console.log('[DEBUG] player pos:', nextX.toFixed(1), nextY.toFixed(1));
      }
      // 行人穿越：撞到記 eventPenalties 扣分
      let hitPedestrian = false;
      for (let npc of currentRoom.npcs) {
        if (npc.type !== 'event_pedestrian') continue;
        if (Math.hypot(nextX - npc.x, nextY - npc.y) < npc.size + 12) hitPedestrian = true;
      }

      if (hitConstruction || hit) {
        if (hitConstruction && !p._prevHitConstruction) p.crashes += 1; // 撞施工區扣分一次
        p._prevHitConstruction = hitConstruction;
        p.speed = 0;
      } else if (hitPedestrian) {
        if (!p._prevHitPedestrian) p.eventPenalties += 1; // 撞行人扣分一次（不重複）
        p._prevHitPedestrian = true;
        p.speed = 0;
      } else {
        p._prevHitConstruction = false;
        p._prevHitPedestrian = false;
        p.x = nextX;
        p.y = nextY;
      }

      p.sensors = {
        f: castRay(p.x, p.y, p.angle,       currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects),
        l: castRay(p.x, p.y, p.angle - 45,  currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects),
        r: castRay(p.x, p.y, p.angle + 45,  currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects),
        fl: castRay(p.x, p.y, p.angle - 90, currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects),
        fr: castRay(p.x, p.y, p.angle + 90, currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects),
        
      };
// 新增：AI 視覺辨識與行為預測
      p.vision = castVisionRay(p.x, p.y, p.angle, currentRoom.objects, currentRoom.npcs, currentRoom.eventObjects);
      // 新增：高精度地圖 GPS 座標
      p.gps = { x: p.x, y: p.y };
      let g = currentRoom.goal;
      if (!p.finished && p.x > g.x && p.x < g.x + g.w && p.y > g.y && p.y < g.y + g.h) {
        p.finished = true;
      }
    }

    // 廣播房間狀態
    io.to(currentRoom.roomId).emit('state', {
      players: currentRoom.players,
      npcs: currentRoom.npcs,
      trafficLights: currentRoom.trafficLights,
      tick: currentRoom.tick
    });
  }
}, 50);

http.listen(3000, () => console.log('✅ 優化版智慧交通模擬伺服器已啟動！(Port 3000)'));