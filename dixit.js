var dixit = require('express')();
var http = require('http').Server(dixit);
var io = require('socket.io')(http);

dixit.get('/', function(req, res) {
   res.sendFile('dixit.html', {root: __dirname});
});

let images = [];

for (let i = 0; i < 60; i++) {
  images.push(i);
}

shuffleDeck(images);

function shuffleDeck(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function dealHand(array) {
  let output = array.slice(0, 5);
  array.splice(0, 5);
  return output;
}

function dealCard(array) {
  let output = array[0];
  array.shift();
  return output;
}

function playersOnline(map) {
  let playerNames = [];
  for (let value of map.values()) {
    playerNames.push(value.player + ' (' + value.score + ')');
  }
  return playerNames;
}

function scoreForTheRound(map) {
  let playerScores = [];
  for (let value of map.values()) {
    playerScores.push(value.player + ' scored ' + value.scoreThisRound + ' points this round');
    value.scoreThisRound = 0;
  }
  return playerScores;
}

function currentStoryteller(map) {
  for (let value of map.values()) {
    if (value.id == storyteller[0]) {
      return value.player;
    }
  }
}

var cardsInPlay = new Map();
var storyteller = [];
var votes = 0;

io.on('connection', function(socket) {
  socket.player = 'unnamed player';
  socket.score = 0;
  socket.scoreThisRound = 0;
  storyteller.push(socket.id);
  socket.cardsInHand = dealHand(images);

  let players = io.sockets.sockets;

  io.sockets.emit('playersOnline', {names: playersOnline(players)});
  io.sockets.emit('storyteller', {storyteller: currentStoryteller(players)});

  console.log('User ' + socket.id + ' is online.');

  socket.emit('newclientconnect', socket.cardsInHand);

  socket.on('playCard', function(data) {
    if (socket.id != storyteller[0] && cardsInPlay.size <= 0) {
      socket.emit('wait', data);
      return;
    }
    for (let card of cardsInPlay.values()) {
      if (card.playedBy == socket.id) {
        socket.emit('alreadyPlayed', data);
        return;
      }
    }
    let index = socket.cardsInHand.indexOf(data);
    socket.cardsInHand.splice(index, 1);
    cardsInPlay.set(data, {
      playedBy: socket.id,
      votedBy: []
    });
    if (cardsInPlay.size == players.size) {
      io.sockets.emit('image', [...cardsInPlay.keys()]);
    }
  });

  socket.on('vote', function(data) {
    for (let card of cardsInPlay.values()) {
      for (let voter of card.votedBy) {
        if (voter == socket.id) {
          socket.emit('alreadyVoted');
          return;
        }
      }
    }
    if (socket.id == storyteller[0]) {
      socket.emit('noVote');
      return;
    }
    //data is an HTML id property of the image being voted for,
    //hence it is a string and needs to be converted to integer
    //to work as a key for the map of cards in play
    if (cardsInPlay.get(parseInt(data)).playedBy == socket.id) {
      socket.emit('autoVote');
      return;
    }
    //ditto for parseInt
    cardsInPlay.get(parseInt(data)).votedBy.push(socket.id);
    votes++;
    if (votes >= cardsInPlay.size - 1) {
      tallyVotes();
      prepForNextRound();
      io.sockets.emit('scoreUpdate', {scores: scoreForTheRound(players)});
      for (let player of players.values()) {
        player.scoreThisRound = 0;
      }
      votes = 0;
    }
  });

  socket.on('readyForNextRound', function() {
    let hand = players.get(socket.id).cardsInHand;
    socket.emit('nextRound', hand[hand.length - 1]);
  });

  function tallyVotes() {
    for (let card of cardsInPlay.values()) {
      if (card.playedBy == storyteller[0]) {
        if (card.votedBy.length == 0 || card.votedBy.length >= cardsInPlay.size - 1) {
          for (let player of players.values()) {
            if (player.id != storyteller[0]) {
              player.score += 2;
              player.scoreThisRound += 2;
            }
          }
          return;
        } else {
          players.get(storyteller[0]).score += 3;
          players.get(storyteller[0]).scoreThisRound += 3;
          for (let voter of card.votedBy) {
            players.get(voter).score += 3;
            players.get(voter).scoreThisRound += 3;
          }
        }
      } else {
        players.get(card.playedBy).score += card.votedBy.length;
        players.get(card.playedBy).scoreThisRound += card.votedBy.length;
      }
    }
  }

  function prepForNextRound() {
    storyteller.push(storyteller.shift());
    io.sockets.emit('playersOnline', {names: playersOnline(players)});
    io.sockets.emit('storyteller', {storyteller: currentStoryteller(players)});
    cardsInPlay.clear();
    for (let player of players.values()) {
      if (player.cardsInHand.length < 5) {
        var cardToDeal = dealCard(images)
        player.cardsInHand.push(cardToDeal);
      }
    }
  }

  socket.on('assignName', function(data) {
    socket.player = data;
    io.sockets.emit('playersOnline', {names: playersOnline(players)});
    io.sockets.emit('storyteller', {storyteller: currentStoryteller(players)});
  });

  socket.on('disconnect', function() {
    console.log('User ' + socket.id + ' is offline.');
    storyteller.splice(storyteller.indexOf(socket.id), 1);
    players.delete(socket.id);
    io.sockets.emit('playersOnline', {names: playersOnline(players)});
    io.sockets.emit('storyteller', {storyteller: currentStoryteller(players)});
  });
});

http.listen(3000, function() {
   console.log('listening on *:3000');
});
