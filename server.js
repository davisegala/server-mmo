/**
 * TIBIA 7.4 CLASSIC - MULTIPLAYER WEBSOCKET & STATIC SERVER (MAX 5 PLAYERS)
 * Serve automaticamente index.html e qualquer arquivo estático (.css, .js, .png)
 * na raiz ou na pasta /public, além de gerenciar contas em database.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const DB_FILE = path.join(__dirname, 'database.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

// --- 1. BANCO DE DADOS EM ARQUIVO JSON ---
function loadDatabase() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ accounts: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
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
const activePlayers = new Map();

// --- 2. SERVIDOR HTTP DE ARQUIVOS ESTÁTICOS (Suporta Módulos e Imagens) ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      server: 'Tibia 7.4 Remastered Server',
      connectedPlayers: activePlayers.size,
      maxPlayers: MAX_PLAYERS
    }));
    return;
  }

  let safeUrl = req.url.split('?')[0];
  if (safeUrl === '/') safeUrl = '/index.html';

  // Procura primeiro em /public, depois na raiz do repositório
  let filePath = path.join(__dirname, 'public', safeUrl);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, safeUrl);
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Arquivo não encontrado no servidor Tibia 7.4');
  }
});

// --- 3. SERVIDOR WEBSOCKET MULTIPLAYER ---
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
      message: `Servidor lotado (${MAX_PLAYERS}/${MAX_PLAYERS} jogadores).`
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
      console.error('Erro ao processar pacote:', err);
    }
  });

  ws.on('close', () => {
    if (authenticatedAccount && activePlayers.has(ws)) {
      const player = activePlayers.get(ws);
      db = loadDatabase();
      if (db.accounts[authenticatedAccount]) {
        db.accounts[authenticatedAccount].character = player;
        saveDatabase(db);
      }
      activePlayers.delete(ws);
      broadcast({ type: 'PLAYER_LEAVE', id: player.id, name: player.name });
    }
  });

  function handlePacket(socket, pkt) {
    switch (pkt.type) {
      case 'AUTH_LOGIN': {
        const username = (pkt.username || '').trim().toLowerCase();
        const password = pkt.password || '';
        db = loadDatabase();
        let acc = db.accounts[username];

        if (!acc) {
          const newChar = createDefaultCharacter(username, username, 'Elite Knight');
          newChar.id = 'char_' + username;
          acc = { password, character: newChar };
          db.accounts[username] = acc;
          saveDatabase(db);
        } else if (acc.password !== password) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Senha incorreta!' }));
          return;
        }

        authenticatedAccount = username;
        const char = acc.character || createDefaultCharacter(username, 'Knight Hero');
        char.id = 'char_' + username;
        activePlayers.set(socket, char);

        const others = [];
        for (const [otherSocket, otherPlayer] of activePlayers.entries()) {
          if (otherSocket !== socket) others.push(otherPlayer);
        }

        socket.send(JSON.stringify({
          type: 'AUTH_RESULT',
          success: true,
          character: char,
          otherPlayers: others
        }));

        broadcast({ type: 'PLAYER_JOIN', player: char }, socket);
        break;
      }

      case 'AUTH_REGISTER': {
        const username = (pkt.username || '').trim().toLowerCase();
        const password = pkt.password || '';
        const charName = pkt.charName || 'Knight Hero';
        const vocation = pkt.vocation || 'Elite Knight';
        db = loadDatabase();

        if (db.accounts[username]) {
          socket.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Conta já existe!' }));
          return;
        }

        const newChar = createDefaultCharacter(username, charName, vocation);
        newChar.id = 'char_' + username;
        db.accounts[username] = { password, character: newChar };
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

        broadcast({ type: 'PLAYER_JOIN', player: newChar }, socket);
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
    x: 14, // Nasce no Templo de Thais-Mini
    y: 14,
    direction: 'S',
    hp: vocation === 'Master Sorcerer' ? 120 : 165,
    maxHp: vocation === 'Master Sorcerer' ? 120 : 165,
    mp: vocation === 'Master Sorcerer' ? 120 : 65,
    maxMp: vocation === 'Master Sorcerer' ? 120 : 65,
    level: 1,
    xp: 0,
    nextLevelXp: 100,
    updatedAt: Date.now()
  };
}

server.listen(PORT, () => {
  console.log(`⚔️ TIBIA 7.4 REMASTERED SERVER ONLINE NA PORTA ${PORT}`);
});