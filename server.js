const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// HTTP Server
const server = http.createServer((req, res) => {
  const cleanUrl = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(PUBLIC_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

// WebSocket Server
const wss = new WebSocket.Server({ server });

// Rooms State
const rooms = new Map();

// Helper: Get local LAN IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function generateRoomId() {
  let id;
  do {
    id = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(id));
  return id;
}

// Bot speech templates
const BOT_NAMES = ['艾力克斯', '貝拉', '克里斯', '黛西', '伊森', '費歐娜', '加百列', '海倫娜'];

class WerewolfRoom {
  constructor(id, hostWs, hostName) {
    this.id = id;
    this.status = 'LOBBY'; // LOBBY, DEALING, NIGHT_WOLVES, NIGHT_WITCH, NIGHT_SEER, DAY_ANNOUNCE, DAY_SPEECH, DAY_VOTING, GAME_OVER
    this.round = 0;
    this.players = []; // Array of 6 seats { id, seat, name, isBot, isHost, ws, role, isAlive, checkedBySeer }
    this.logs = [];
    this.witchHasElixir = true;
    this.witchHasPoison = true;
    this.nightActions = {
      wolfVotes: {}, // seat -> targetSeat
      wolfTarget: null,
      witchSave: false,
      witchPoisonTarget: null,
      seerCheckTarget: null,
      seerResult: null
    };
    this.dayState = {
      deaths: [],
      currentSpeakerSeat: null,
      speechOrder: [],
      votes: {}, // voterSeat -> targetSeat
      voteCount: {}
    };
    this.timer = null;
    this.timerSeconds = 0;

    // Add host as seat 1
    this.addPlayer(hostWs, hostName, true);
  }

  addPlayer(ws, name, isHost = false) {
    if (this.players.length >= 6) return null;
    const seat = this.players.length + 1;
    const player = {
      id: Math.random().toString(36).substring(2, 9),
      seat,
      name: name || `玩家 ${seat}`,
      isBot: false,
      isHost,
      ws,
      role: null,
      isAlive: true,
      ready: isHost ? true : false
    };
    this.players.push(player);
    return player;
  }

  addBot() {
    if (this.players.length >= 6) return null;
    const seat = this.players.length + 1;
    const botName = BOT_NAMES[(seat + Math.floor(Math.random() * 4)) % BOT_NAMES.length] + ' (AI)';
    const bot = {
      id: 'bot_' + Math.random().toString(36).substring(2, 9),
      seat,
      name: botName,
      isBot: true,
      isHost: false,
      ws: null,
      role: null,
      isAlive: true,
      ready: true
    };
    this.players.push(bot);
    return bot;
  }

  removeBot(seat) {
    const idx = this.players.findIndex(p => p.seat === seat && p.isBot);
    if (idx !== -1) {
      this.players.splice(idx, 1);
      // Re-index seats
      this.players.forEach((p, i) => p.seat = i + 1);
      this.broadcastState();
    }
  }

  fillBots() {
    while (this.players.length < 6) {
      this.addBot();
    }
    this.broadcastState();
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(data);
      }
    });
  }

  sendToPlayer(player, message) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  }

  // Get state tailored for a specific player (hiding hidden cards, etc.)
  getPlayerState(player) {
    const isGameOver = this.status === 'GAME_OVER';
    return {
      roomId: this.id,
      status: this.status,
      round: this.round,
      timerSeconds: this.timerSeconds,
      mySeat: player ? player.seat : null,
      myRole: player ? player.role : null,
      witchHasElixir: this.witchHasElixir,
      witchHasPoison: this.witchHasPoison,
      nightTargetForWitch: (player && player.role === 'witch' && this.status === 'NIGHT_WITCH') ? this.nightActions.wolfTarget : null,
      seerResult: (player && player.role === 'seer') ? this.nightActions.seerResult : null,
      players: this.players.map(p => ({
        seat: p.seat,
        name: p.name,
        isBot: p.isBot,
        isHost: p.isHost,
        isAlive: p.isAlive,
        ready: p.ready,
        // Only show role if game is over, or to the player themselves, or fellow wolves
        role: isGameOver ? p.role : (
          (player && (player.seat === p.seat || (player.role === 'wolf' && p.role === 'wolf'))) ? p.role : null
        )
      })),
      dayState: {
        deaths: this.dayState.deaths,
        currentSpeakerSeat: this.dayState.currentSpeakerSeat,
        votes: this.status === 'DAY_VOTE_RESULT' || isGameOver ? this.dayState.votes : null
      },
      logs: this.logs.slice(-25)
    };
  }

  broadcastState() {
    this.players.forEach(p => {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'ROOM_STATE',
          state: this.getPlayerState(p)
        }));
      }
    });
  }

  addLog(content, tag = 'SYSTEM') {
    this.logs.push({
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      tag,
      content
    });
  }

  startGame() {
    if (this.players.length !== 6) return;
    this.status = 'DEALING';
    this.round = 1;
    this.witchHasElixir = true;
    this.witchHasPoison = true;
    this.logs = [];

    // Assign roles according to official 6-player board:
    // 2 狼人 (wolf), 1 預言家 (seer), 1 女巫 (witch), 2 平民 (villager)
    const roles = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];
    // Shuffle
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    this.players.forEach((p, idx) => {
      p.role = roles[idx];
      p.isAlive = true;
    });

    this.addLog('遊戲開始！身份發放完畢，請記住您的專屬角色。');
    this.startCountdown(7, () => {
      this.enterNight();
    });
  }

  startCountdown(seconds, callback) {
    if (this.timer) clearInterval(this.timer);
    this.timerSeconds = seconds;
    this.broadcastState();

    this.timer = setInterval(() => {
      this.timerSeconds--;
      this.broadcastState();
      if (this.timerSeconds <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        if (callback) callback();
      }
    }, 1000);
  }

  enterNight() {
    this.addLog(`=== 第 ${this.round} 夜：天黑請閉眼 ===`, 'NIGHT');
    this.nightActions = {
      wolfVotes: {},
      wolfTarget: null,
      witchSave: false,
      witchPoisonTarget: null,
      seerCheckTarget: null,
      seerResult: null
    };

    // Step 1: Wolves phase
    this.status = 'NIGHT_WOLVES';
    this.addLog('狼人請睜眼，商討並選擇今晚要襲擊的目標。', 'NIGHT');
    this.broadcastState();

    // Trigger AI wolves if any
    setTimeout(() => {
      this.handleBotWolves();
    }, 2000);

    this.startCountdown(15, () => {
      this.finishWolvesPhase();
    });
  }

  handleBotWolves() {
    const wolves = this.players.filter(p => p.role === 'wolf' && p.isAlive);
    const goodAlive = this.players.filter(p => p.role !== 'wolf' && p.isAlive);
    if (goodAlive.length === 0) return;

    // Pick a random good player as candidate
    const target = goodAlive[Math.floor(Math.random() * goodAlive.length)];
    wolves.forEach(w => {
      if (w.isBot) {
        this.nightActions.wolfVotes[w.seat] = target.seat;
      }
    });

    // Check if all wolves voted
    const humanWolves = wolves.filter(w => !w.isBot);
    if (humanWolves.length === 0) {
      this.nightActions.wolfTarget = target.seat;
    }
  }

  onWolfAction(player, targetSeat) {
    if (this.status !== 'NIGHT_WOLVES' || player.role !== 'wolf' || !player.isAlive) return;
    this.nightActions.wolfVotes[player.seat] = targetSeat;

    // Broadcast wolf vote to fellow wolves
    const wolves = this.players.filter(p => p.role === 'wolf' && p.isAlive);
    wolves.forEach(w => {
      this.sendToPlayer(w, {
        type: 'WOLF_VOTE_SYNC',
        voter: player.seat,
        target: targetSeat
      });
    });

    // If all alive wolves chose target
    const allVoted = wolves.every(w => this.nightActions.wolfVotes[w.seat] !== undefined);
    if (allVoted) {
      // Find consensus
      const voteCounts = {};
      Object.values(this.nightActions.wolfVotes).forEach(t => {
        voteCounts[t] = (voteCounts[t] || 0) + 1;
      });
      let maxTarget = targetSeat;
      let maxCount = 0;
      for (const [t, count] of Object.entries(voteCounts)) {
        if (count > maxCount) {
          maxCount = count;
          maxTarget = parseInt(t);
        }
      }
      this.nightActions.wolfTarget = maxTarget;
      // Advance if done early
      if (this.timerSeconds > 3) {
        this.startCountdown(3, () => this.finishWolvesPhase());
      }
    }
  }

  finishWolvesPhase() {
    // Determine final wolf target
    const wolves = this.players.filter(p => p.role === 'wolf' && p.isAlive);
    if (!this.nightActions.wolfTarget && wolves.length > 0) {
      const goodAlive = this.players.filter(p => p.role !== 'wolf' && p.isAlive);
      if (goodAlive.length > 0) {
        this.nightActions.wolfTarget = goodAlive[0].seat;
      }
    }

    // Step 2: Witch phase
    this.enterWitchPhase();
  }

  enterWitchPhase() {
    this.status = 'NIGHT_WITCH';
    this.addLog('女巫請睜眼。', 'NIGHT');
    this.broadcastState();

    const witch = this.players.find(p => p.role === 'witch');
    if (witch && witch.isBot && witch.isAlive) {
      setTimeout(() => {
        // AI Witch Logic
        // Round 1: save victim
        if (this.round === 1 && this.witchHasElixir && this.nightActions.wolfTarget) {
          this.nightActions.witchSave = true;
          this.witchHasElixir = false;
        } else if (this.witchHasPoison && Math.random() < 0.3) {
          // 30% chance to poison a suspect later
          const suspects = this.players.filter(p => p.isAlive && p.seat !== witch.seat && p.seat !== this.nightActions.wolfTarget);
          if (suspects.length > 0) {
            const target = suspects[Math.floor(Math.random() * suspects.length)];
            this.nightActions.witchPoisonTarget = target.seat;
            this.witchHasPoison = false;
          }
        }
      }, 1500);
    }

    this.startCountdown(12, () => {
      this.enterSeerPhase();
    });
  }

  onWitchAction(player, action, targetSeat) {
    if (this.status !== 'NIGHT_WITCH' || player.role !== 'witch' || !player.isAlive) return;

    if (action === 'SAVE' && this.witchHasElixir && this.nightActions.wolfTarget) {
      // Rule: can save (first night self-save allowed)
      if (this.nightActions.wolfTarget === player.seat && this.round > 1) {
        // cannot self save after night 1
        return;
      }
      this.nightActions.witchSave = true;
      this.witchHasElixir = false;
      this.broadcastState();
    } else if (action === 'POISON' && this.witchHasPoison && targetSeat) {
      this.nightActions.witchPoisonTarget = targetSeat;
      this.witchHasPoison = false;
      this.broadcastState();
    } else if (action === 'PASS') {
      if (this.timerSeconds > 2) {
        this.startCountdown(2, () => this.enterSeerPhase());
      }
    }
  }

  enterSeerPhase() {
    this.status = 'NIGHT_SEER';
    this.addLog('預言家請睜眼，選擇一名玩家查驗身份。', 'NIGHT');
    this.broadcastState();

    const seer = this.players.find(p => p.role === 'seer');
    if (seer && seer.isBot && seer.isAlive) {
      setTimeout(() => {
        const unchecked = this.players.filter(p => p.isAlive && p.seat !== seer.seat && !p.checkedBySeer);
        if (unchecked.length > 0) {
          const target = unchecked[Math.floor(Math.random() * unchecked.length)];
          target.checkedBySeer = true;
          this.nightActions.seerCheckTarget = target.seat;
          this.nightActions.seerResult = {
            seat: target.seat,
            name: target.name,
            isWolf: target.role === 'wolf'
          };
        }
      }, 1500);
    }

    this.startCountdown(10, () => {
      this.enterDayPhase();
    });
  }

  onSeerAction(player, targetSeat) {
    if (this.status !== 'NIGHT_SEER' || player.role !== 'seer' || !player.isAlive) return;
    const target = this.players.find(p => p.seat === targetSeat && p.isAlive);
    if (!target) return;

    target.checkedBySeer = true;
    this.nightActions.seerCheckTarget = targetSeat;
    this.nightActions.seerResult = {
      seat: target.seat,
      name: target.name,
      isWolf: target.role === 'wolf'
    };

    this.sendToPlayer(player, {
      type: 'SEER_CHECK_RESULT',
      result: this.nightActions.seerResult
    });

    if (this.timerSeconds > 3) {
      this.startCountdown(3, () => this.enterDayPhase());
    }
  }

  enterDayPhase() {
    this.status = 'DAY_ANNOUNCE';
    const deaths = [];

    // Calculate Wolf Kill
    if (this.nightActions.wolfTarget && !this.nightActions.witchSave) {
      deaths.push(this.nightActions.wolfTarget);
    }

    // Calculate Witch Poison
    if (this.nightActions.witchPoisonTarget && !deaths.includes(this.nightActions.witchPoisonTarget)) {
      deaths.push(this.nightActions.witchPoisonTarget);
    }

    // Apply deaths
    deaths.forEach(seat => {
      const p = this.players.find(pl => pl.seat === seat);
      if (p) p.isAlive = false;
    });

    this.dayState.deaths = deaths;

    this.addLog(`=== 第 ${this.round} 天：天亮破曉 ===`, 'DAY');
    if (deaths.length === 0) {
      this.addLog('昨晚是平安夜，沒有人倒下！', 'ANNOUNCE');
    } else {
      const names = deaths.map(seat => `${seat}號 ${this.players.find(p => p.seat === seat).name}`).join('、');
      this.addLog(`昨晚死亡的玩家是：【${names}】`, 'ANNOUNCE');
    }

    this.broadcastState();

    // Check Victory condition immediately
    if (this.checkWinCondition()) return;

    // Countdown to discussion phase
    this.startCountdown(6, () => {
      this.enterDiscussionPhase();
    });
  }

  enterDiscussionPhase() {
    this.status = 'DAY_SPEECH';
    const aliveSeats = this.players.filter(p => p.isAlive).map(p => p.seat);
    this.dayState.speechOrder = aliveSeats;
    this.nextSpeaker(0);
  }

  nextSpeaker(orderIndex) {
    if (orderIndex >= this.dayState.speechOrder.length) {
      // All speeches done, go to voting
      this.enterVotingPhase();
      return;
    }

    const currentSeat = this.dayState.speechOrder[orderIndex];
    this.dayState.currentSpeakerSeat = currentSeat;
    const speaker = this.players.find(p => p.seat === currentSeat);

    this.addLog(`輪到 【${speaker.seat}號 ${speaker.name}】 發言。`, 'SPEECH');
    this.broadcastState();

    if (speaker.isBot) {
      // AI generates speech
      setTimeout(() => {
        this.generateBotSpeech(speaker);
        setTimeout(() => {
          this.nextSpeaker(orderIndex + 1);
        }, 3500);
      }, 1500);
      this.startCountdown(6, null);
    } else {
      // Human speaker has 35s
      this.startCountdown(35, () => {
        this.nextSpeaker(orderIndex + 1);
      });
    }
  }

  generateBotSpeech(bot) {
    let msg = '';
    const alivePlayers = this.players.filter(p => p.isAlive && p.seat !== bot.seat);
    const deadPlayers = this.players.filter(p => !p.isAlive);

    if (bot.role === 'seer') {
      if (this.nightActions.seerResult) {
        const res = this.nightActions.seerResult;
        msg = `我是真預言家！昨晚我查驗了 ${res.seat} 號 ${res.name}，他是【${res.isWolf ? '查殺！是狼人！' : '金水！是好人！'}】大家今天跟我全票出狼！`;
      } else {
        msg = '我是預言家，目前局勢還不明朗，大家請誠實表態，我會帶隊好人！';
      }
    } else if (bot.role === 'wolf') {
      const wolves = this.players.filter(p => p.role === 'wolf');
      const mate = wolves.find(w => w.seat !== bot.seat);
      const target = alivePlayers.find(p => p.role !== 'wolf') || alivePlayers[0];

      const bluffTypes = [
        `我是個平民好人，昨晚沒有任何動作。我覺得 ${target ? target.seat + '號' : '後置位'} 發言邏輯有點破綻，可以重點觀察。`,
        `我是一張大好人牌，昨晚 ${deadPlayers.length > 0 ? deadPlayers[0].seat + '號被刀' : '平安夜'}，狼坑很窄，我傾向相信前面的好人發言。`,
        `前置位發言我聽下來覺得還算誠懇，但我強烈懷疑 ${target ? target.seat + '號' : '對跳預言家的人'}，建議大家慎重投票！`
      ];
      msg = bluffTypes[Math.floor(Math.random() * bluffTypes.length)];
    } else if (bot.role === 'witch') {
      msg = `我是好人陣營，我的藥水情況先保留。今天先聽預言家報查驗資訊，我會保護好人！`;
    } else {
      // Villager
      const cand = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      msg = `我是平民，沒什麼特殊技能。目前看來場上氣氛很緊繃，我建議聽真預言家的金水/查殺來歸票出人！`;
    }

    this.onPlayerChat(bot, msg);
  }

  onFinishSpeech(player) {
    if (this.status === 'DAY_SPEECH' && this.dayState.currentSpeakerSeat === player.seat) {
      if (this.timer) clearInterval(this.timer);
      const currentIndex = this.dayState.speechOrder.indexOf(player.seat);
      this.nextSpeaker(currentIndex + 1);
    }
  }

  onPlayerChat(player, text) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim().substring(0, 100);
    this.addLog(`${player.seat}號 ${player.name}: ${cleanText}`, player.isAlive ? 'CHAT' : 'GHOST');
    this.broadcastState();
  }

  enterVotingPhase() {
    this.status = 'DAY_VOTING';
    this.dayState.votes = {};
    this.dayState.currentSpeakerSeat = null;
    this.addLog('發言結束，進入放逐投票階段！請所有存活玩家投出您認為是狼人的玩家。', 'VOTE');
    this.broadcastState();

    // AI votes
    setTimeout(() => {
      const alivePlayers = this.players.filter(p => p.isAlive);
      this.players.forEach(p => {
        if (p.isBot && p.isAlive) {
          // Vote for another alive player
          let candidates = alivePlayers.filter(cand => cand.seat !== p.seat);
          // If bot is good and seer found a wolf, vote the wolf
          if (p.role !== 'wolf' && this.nightActions.seerResult && this.nightActions.seerResult.isWolf) {
            const wolfSeat = this.nightActions.seerResult.seat;
            if (candidates.some(c => c.seat === wolfSeat)) {
              candidates = candidates.filter(c => c.seat === wolfSeat);
            }
          } else if (p.role === 'wolf') {
            // Wolves don't vote wolves
            const nonWolves = candidates.filter(c => c.role !== 'wolf');
            if (nonWolves.length > 0) candidates = nonWolves;
          }
          if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            this.dayState.votes[p.seat] = pick.seat;
          }
        }
      });
      this.checkAllVotes();
    }, 2500);

    this.startCountdown(20, () => {
      this.finishVotingPhase();
    });
  }

  onPlayerVote(player, targetSeat) {
    if (this.status !== 'DAY_VOTING' || !player.isAlive) return;
    this.dayState.votes[player.seat] = targetSeat;
    this.broadcastState();
    this.checkAllVotes();
  }

  checkAllVotes() {
    const alivePlayers = this.players.filter(p => p.isAlive);
    const allVoted = alivePlayers.every(p => this.dayState.votes[p.seat] !== undefined);
    if (allVoted && this.timerSeconds > 2) {
      this.startCountdown(2, () => this.finishVotingPhase());
    }
  }

  finishVotingPhase() {
    this.status = 'DAY_VOTE_RESULT';
    const tally = {};
    Object.entries(this.dayState.votes).forEach(([voter, target]) => {
      if (target) {
        tally[target] = (tally[target] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let exiledSeat = null;
    let tie = false;

    for (const [seat, count] of Object.entries(tally)) {
      if (count > maxVotes) {
        maxVotes = count;
        exiledSeat = parseInt(seat);
        tie = false;
      } else if (count === maxVotes) {
        tie = true;
      }
    }

    // Announce votes detail
    const details = Object.entries(this.dayState.votes)
      .map(([v, t]) => `${v}號➔${t ? t + '號' : '棄票'}`)
      .join('，');
    this.addLog(`【投票明細】：${details}`, 'VOTE');

    if (tie || !exiledSeat || maxVotes === 0) {
      this.addLog('平票或無人過半，本輪無人被放逐出局！', 'ANNOUNCE');
    } else {
      const exiledPlayer = this.players.find(p => p.seat === exiledSeat);
      if (exiledPlayer) {
        exiledPlayer.isAlive = false;
        this.addLog(`【${exiledPlayer.seat}號 ${exiledPlayer.name}】 獲得 ${maxVotes} 票，被白天投票放逐出局！`, 'ANNOUNCE');
      }
    }

    this.broadcastState();

    if (this.checkWinCondition()) return;

    this.startCountdown(7, () => {
      this.round++;
      this.enterNight();
    });
  }

  checkWinCondition() {
    const aliveWolves = this.players.filter(p => p.isAlive && p.role === 'wolf');
    const aliveGoods = this.players.filter(p => p.isAlive && p.role !== 'wolf');

    if (aliveWolves.length === 0) {
      // Good wins
      this.status = 'GAME_OVER';
      this.addLog('🎉【好人陣營獲勝！】所有狼人已被成功放逐淘汰！', 'VICTORY');
      this.broadcastState();
      return true;
    }

    if (aliveGoods.length === 0 || aliveWolves.length >= aliveGoods.length) {
      // Wolves win (kill all goods or control the board)
      this.status = 'GAME_OVER';
      this.addLog('🐺【狼人陣營獲勝！】黑夜籠罩村莊，好人陣營已無力回天！', 'VICTORY');
      this.broadcastState();
      return true;
    }

    return false;
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayer = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'CREATE_ROOM') {
        const roomId = generateRoomId();
        const room = new WerewolfRoom(roomId, ws, data.name);
        rooms.set(roomId, room);
        currentRoom = room;
        currentPlayer = room.players[0];

        ws.send(JSON.stringify({
          type: 'JOINED_ROOM',
          roomId,
          seat: currentPlayer.seat,
          isHost: true
        }));
        room.broadcastState();
      }
      else if (data.type === 'JOIN_ROOM') {
        const room = rooms.get(data.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: '房間代碼不存在！' }));
          return;
        }
        if (room.status !== 'LOBBY') {
          ws.send(JSON.stringify({ type: 'ERROR', message: '遊戲已經開始，無法加入！' }));
          return;
        }
        if (room.players.length >= 6) {
          ws.send(JSON.stringify({ type: 'ERROR', message: '房間已滿 6 人！' }));
          return;
        }

        const player = room.addPlayer(ws, data.name, false);
        currentRoom = room;
        currentPlayer = player;

        ws.send(JSON.stringify({
          type: 'JOINED_ROOM',
          roomId: room.id,
          seat: player.seat,
          isHost: false
        }));
        room.addLog(`玩家 【${player.seat}號 ${player.name}】 加入了房間。`);
        room.broadcastState();
      }
      else if (data.type === 'FILL_BOTS' && currentRoom && currentPlayer && currentPlayer.isHost) {
        currentRoom.fillBots();
      }
      else if (data.type === 'REMOVE_BOT' && currentRoom && currentPlayer && currentPlayer.isHost) {
        currentRoom.removeBot(data.seat);
      }
      else if (data.type === 'START_GAME' && currentRoom && currentPlayer && currentPlayer.isHost) {
        currentRoom.startGame();
      }
      else if (data.type === 'WOLF_ACTION' && currentRoom && currentPlayer) {
        currentRoom.onWolfAction(currentPlayer, data.target);
      }
      else if (data.type === 'WITCH_ACTION' && currentRoom && currentPlayer) {
        currentRoom.onWitchAction(currentPlayer, data.action, data.target);
      }
      else if (data.type === 'SEER_ACTION' && currentRoom && currentPlayer) {
        currentRoom.onSeerAction(currentPlayer, data.target);
      }
      else if (data.type === 'PLAYER_CHAT' && currentRoom && currentPlayer) {
        currentRoom.onPlayerChat(currentPlayer, data.text);
      }
      else if (data.type === 'FINISH_SPEECH' && currentRoom && currentPlayer) {
        currentRoom.onFinishSpeech(currentPlayer);
      }
      else if (data.type === 'PLAYER_VOTE' && currentRoom && currentPlayer) {
        currentRoom.onPlayerVote(currentPlayer, data.target);
      }
      else if (data.type === 'RESTART_GAME' && currentRoom && currentPlayer && currentPlayer.isHost) {
        currentRoom.status = 'LOBBY';
        currentRoom.broadcastState();
      }
    } catch (err) {
      console.error('WS Error:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentPlayer) {
      currentRoom.addLog(`玩家 【${currentPlayer.seat}號 ${currentPlayer.name}】 斷線離開了遊戲。`);
      // If in lobby, remove player
      if (currentRoom.status === 'LOBBY') {
        const idx = currentRoom.players.findIndex(p => p.id === currentPlayer.id);
        if (idx !== -1) {
          currentRoom.players.splice(idx, 1);
          currentRoom.players.forEach((p, i) => p.seat = i + 1);
        }
        if (currentRoom.players.length === 0) {
          rooms.delete(currentRoom.id);
        } else {
          // Reassign host if host left
          if (currentPlayer.isHost) {
            currentRoom.players[0].isHost = true;
          }
          currentRoom.broadcastState();
        }
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLocalIP();
  console.log(`=======================================================`);
  console.log(`🐺 6人狼人殺多人連線伺服器已成功啟動！`);
  console.log(`🏠 本機瀏覽器開啟:  http://localhost:${PORT}`);
  console.log(`📱 同區網手機好友開啟: http://${lanIP}:${PORT}`);
  console.log(`=======================================================`);
});
