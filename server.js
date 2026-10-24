/**
 * TIBIA 7.x CLASSIC - MULTIPLAYER WEBSOCKET SERVER (MAX 5 PLAYERS)
 * Servidor leve em Node.js com persistência em JSON e controle de sala.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const DB_FILE = path.join(__dirname, 'database.json');

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

// --- 2. SERVIDOR HTTP (Healthcheck para manter online na nuvem) ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    status: 'online',
    server: 'Tibia 7.4 Dedicated WebSocket Server',
    connectedPlayers: activePlayers.size,
    maxPlayers: MAX_PLAYERS
  }));
});

// --- 3. SERVIDOR WEBSOCKET ---
const wss = new WebSocketServer({ server });

// Mapa de conexões ativas: socket -> playerState
const activePlayers = new Map();

function broadcast(packet, excludeWs = null) {
  const message = JSON.stringify(packet);
  for (const [ws, _] of activePlayers.entries()) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  // Verifica se atingiu o limite de 5 jogadores
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
      
      // Salva o último estado no banco antes de remover
      db = loadDatabase();
      db.accounts[authenticatedAccount].character = player;
      saveDatabase(db);

      activePlayers.delete(ws);

      // Notifica os outros 4 jogadores que este saiu
      broadcast({
        type: 'PLAYER_LEAVE',
        id: player.id,
        name: player.name
      });
    }
  });

  function handlePacket(socket, pkt) {
    switch (pkt.type) {
      // 1. LOGIN / AUTENTICAÇÃO
      case 'AUTH_LOGIN': {
        const { username, password } = pkt;
        db = loadDatabase();
        const acc = db.accounts[username];

        if (!acc) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Conta não encontrada! Use a aba Registrar.' }));
          return;
        }

        if (acc.password !== password) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Senha incorreta!' }));
          return;
        }

        authenticatedAccount = username;
        const char = acc.character || createDefaultCharacter(username, 'Knight Hero');
        char.id = 'char_' + username;
        activePlayers.set(socket, char);

        console.log(`[Login] ${char.name} conectado (${activePlayers.size}/${MAX_PLAYERS})`);

        // Envia confirmação com os dados do personagem e a lista de outros jogadores conectados
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

        // Notifica os outros jogadores que um novo player entrou
        broadcast({
          type: 'PLAYER_JOIN',
          player: char
        }, socket);
        break;
      }

      // 2. REGISTRO DE NOVA CONTA
      case 'AUTH_REGISTER': {
        const { username, password, charName, vocation } = pkt;
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

        console.log(`[Novo Registro] ${newChar.name} criado e conectado.`);

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

      // 3. MOVIMENTO DO JOGADOR
      case 'PLAYER_MOVE': {
        const player = activePlayers.get(socket);
        if (!player) return;

        player.x = pkt.x;
        player.y = pkt.y;
        player.direction = pkt.direction || player.direction;

        // Reenvia para todos os outros conectados
        broadcast({
          type: 'PLAYER_MOVED',
          id: player.id,
          x: player.x,
          y: player.y,
          direction: player.direction
        }, socket);
        break;
      }

      // 4. MENSAGEM NO CHAT
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

      // 5. SALVAR PERSONAGEM
      case 'SAVE_CHARACTER': {
        if (!authenticatedAccount) return;
        const player = activePlayers.get(socket);
        if (!player) return;

        // Mescla atributos atualizados (HP, XP, inventário, equips)
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
    hp: 150,
    maxHp: 150,
    mp: 60,
    maxMp: 60,
    level: 1,
    xp: 0,
    nextLevelXp: 100,
    attackPower: 12,
    defense: 6,
    equipment: { head: null, body: null, weapon: { id: 'item_sword', name: 'Espada Longa', type: 'weapon', stats: { atk: 12, def: 2 } }, shield: null },
    inventory: new Array(20).fill(null),
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