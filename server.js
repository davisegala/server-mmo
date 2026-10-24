/**
 * TIBIA 7.x CLASSIC - MULTIPLAYER WEBSOCKET SERVER (MAX 5 PLAYERS)
 * Servidor leve em Node.js com persistência em JSON (database.json)
 * e entrega automática do cliente index.html se estiver na mesma pasta.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const DB_FILE = path.join(__dirname, 'database.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

// --- 1. BANCO DE DADOS EM ARQUIVO JSON ---
function loadDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ accounts: {} }, null, 2));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Erro ao ler database.json, recriando:', err);
    return { accounts: {} };
  }
}

function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Erro ao salvar database.json:', err);
  }
}

let db = loadDatabase();

// Mapa de conexões ativas: socket -> playerState
const activePlayers = new Map();

// --- 2. SERVIDOR HTTP (Serve o index.html ou Healthcheck JSON) ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      server: 'Tibia 7.4 Dedicated WebSocket Server',
      connectedPlayers: activePlayers.size,
      maxPlayers: MAX_PLAYERS
    }));
    return;
  }

  // Se você colocar o index.html junto no Render/Glitch, o link abrirá o jogo direto!
  if (fs.existsSync(INDEX_FILE)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      server: 'Tibia 7.4 Dedicated WebSocket Server',
      connectedPlayers: activePlayers.size,
      maxPlayers: MAX_PLAYERS,
      hint: 'Conecte seu index.html usando wss:// neste endereço!'
    }));
  }
});

// --- 3. SERVIDOR WEBSOCKET ---
const wss = new WebSocketServer({ server });

function broadcast(packet, excludeWs = null) {
  const message = JSON.stringify(packet);
  for (const [ws] of activePlayers.entries()) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  if (activePlayers.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({
      type: 'SERVER_ERROR',
      message: `O servidor está lotado! Capacidade máxima: ${MAX_PLAYERS}/${MAX_PLAYERS} jogadores.`
    }));
    ws.close();
    return;
  }

  let authenticatedAccount = null;

  ws.on('message', (data) => {
    try {
      const packet = JSON.parse(data.toString());
      handlePacket(ws, packet);
    } catch (err) {
      console.error('Erro ao processar pacote do cliente:', err);
    }
  });

  ws.on('close', () => {
    if (authenticatedAccount && activePlayers.has(ws)) {
      const player = activePlayers.get(ws);
      console.log(`[Disconnect] Jogador "${player.name}" desconectou.`);

      db = loadDatabase();
      if (db.accounts[authenticatedAccount]) {
        db.accounts[authenticatedAccount].character = player;
        saveDatabase(db);
      }

      activePlayers.delete(ws);

      broadcast({
        type: 'PLAYER_LEAVE',
        id: player.id,
        name: player.name
      });
    }
  });

  function handlePacket(socket, pkt) {
    switch (pkt.type) {
      case 'AUTH_LOGIN': {
        const username = (pkt.username || '').trim().toLowerCase();
        const password = pkt.password || '';
        db = loadDatabase();
        let acc = db.accounts[username];

        // Se a conta ainda não existir no servidor, cria automaticamente no primeiro login
        if (!acc) {
          const newChar = createDefaultCharacter(username, username, 'Elite Knight');
          newChar.id = 'char_' + username;
          acc = { password, character: newChar };
          db.accounts[username] = acc;
          saveDatabase(db);
        } else if (acc.password !== password) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Senha incorreta para esta conta!' }));
          return;
        }

        authenticatedAccount = username;
        const char = acc.character || createDefaultCharacter(username, 'Knight Hero');
        char.id = 'char_' + username;
        activePlayers.set(socket, char);

        const others = [];
        for (const [otherSocket, otherPlayer] of activePlayers.entries()) {
          if (otherSocket !== socket) {
            others.push(otherPlayer);
          }
        }

        socket.send(JSON.stringify({
          type: 'AUTH_RESULT',
          success: true,
          character: char,
          otherPlayers: others
        }));

        broadcast({
          type: 'PLAYER_JOIN',
          player: char
        }, socket);
        break;
      }

      case 'AUTH_REGISTER': {
        const username = (pkt.username || '').trim().toLowerCase();
        const password = pkt.password || '';
        const charName = pkt.charName || 'Knight Hero';
        const vocation = pkt.vocation || 'Elite Knight';
        db = loadDatabase();

        if (db.accounts[username]) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Esse nome de conta já existe!' }));
          return;
        }

        const newChar = createDefaultCharacter(username, charName, vocation);
        newChar.id = 'char_' + username;

        db.accounts[username] = {
          password,
          character: newChar
        };
        saveDatabase(db);

        authenticatedAccount = username;
        activePlayers.set(socket, newChar);

        const others = [];
        for (const [otherSocket, otherPlayer] of activePlayers.entries()) {
          if (otherSocket !== socket) others.push(otherPlayer);
        }

        socket.send(JSON.stringify({
          type: 'AUTH_RESULT',
          success: true,
          character: newChar,
          otherPlayers: others
        }));

        broadcast({
          type: 'PLAYER_JOIN',
          player: newChar
        }, socket);
        break;
      }

      case 'PLAYER_MOVE': {
        const player = activePlayers.get(socket);
        if (!player) return;

        player.x = pkt.x;
        player.y = pkt.y;
        player.direction = pkt.direction || player.direction;

        broadcast({
          type: 'PLAYER_MOVED',
          id: player.id,
          x: player.x,
          y: player.y,
          direction: player.direction
        }, socket);
        break;
      }

      case 'PLAYER_CHAT': {
        const player = activePlayers.get(socket);
        if (!player) return;

        broadcast({
          type: 'CHAT_MESSAGE',
          sender: player.name,
          text: pkt.text,
          level: player.level,
          x: player.x,
          y: player.y
        });
        break;
      }

      case 'SAVE_CHARACTER': {
        if (!authenticatedAccount) return;
        const player = activePlayers.get(socket);
        if (!player) return;

        Object.assign(player, pkt.characterData);
        db = loadDatabase();
        if (db.accounts[authenticatedAccount]) {
          db.accounts[authenticatedAccount].character = player;
          saveDatabase(db);
        }

        socket.send(JSON.stringify({ type: 'SAVE_SUCCESS', timestamp: Date.now() }));
        break;
      }
    }
  }
});

function createDefaultCharacter(accountName, name, vocation = 'Elite Knight') {
  return {
    accountName,
    name: name || 'Knight Hero',
    vocation,
    x: 7,
    y: 7,
    direction: 'S',
    hp: vocation === 'Master Sorcerer' ? 120 : 150,
    maxHp: vocation === 'Master Sorcerer' ? 120 : 150,
    mp: vocation === 'Master Sorcerer' ? 110 : 60,
    maxMp: vocation === 'Master Sorcerer' ? 110 : 60,
    level: 1,
    xp: 0,
    nextLevelXp: 100,
    attackPower: 12,
    defense: 6,
    equipment: {
      head: null,
      body: null,
      weapon: { id: 'item_sword', name: 'Espada Longa', spriteId: 'item_sword', type: 'weapon', stats: { atk: 12, def: 2, healAmount: 0 } },
      shield: null
    },
    inventory: [
      { id: 'item_potion', name: 'Poção de Vida', spriteId: 'item_potion', type: 'consumable', stackable: true, count: 3, stats: { atk: 0, def: 0, healAmount: 50 } },
      { id: 'item_gold', name: 'Gold Coin', spriteId: 'item_gold', type: 'valuables', stackable: true, count: 15, stats: { atk: 0, def: 0, healAmount: 0 } },
      ...new Array(18).fill(null)
    ],
    updatedAt: Date.now()
  };
}

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`⚔️  TIBIA 7.4 DEDICATED SERVER ONLINE`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`👥 Limite de Jogadores: ${MAX_PLAYERS} conexões simultâneas`);
  console.log(`💾 Banco de Dados: Local JSON (database.json)`);
  console.log(`===============================================`);
});