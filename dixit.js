var dixit = require('express')();
var http = require('http').Server(dixit);
var io = require('socket.io')(http);
var port = process.env.PORT || 80;

dixit.get('/', function(req, res) {
   res.sendFile('dixit.html', {root: __dirname});
});

var images = [];

populate(images);

shuffle(images);

function populate(array) {
  for (let i = 0; i < 60; i++) {
    array.push(i);
  }
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function reshuffle(array) {
  let newDeck = []
  populate(newDeck);
  shuffle(newDeck);

  //this removes the cards that are still in the game
  //from the new deck
  for (let card of array) {
    if (newDeck.indexOf(card) > -1) {
      newDeck.splice(newDeck.indexOf(card), 1);
    }
  }

  return newDeck;
}

function dealHand(array) {
  if (array.length < 5) {
    array = array.concat(reshuffle(array));
  }
  let output = array.slice(0, 5);
  cardsPlayersHold = cardsPlayersHold.concat(array.splice(0, 5));
  return output;
}

function dealCard(array) {
  if (array.length < 1) {
    array = array.concat(reshuffle(array));
  }
  let output = array[0];
  cardsPlayersHold = cardsPlayersHold.concat(array.shift());
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

var cardsPlayersHold = [];
var cardsInPlay = new Map();
var storyteller = [];
var votes = 0;

io.on('connection', function(socket) {
  socket.player = 'unnamed player';
  socket.score = 0;
  socket.scoreThisRound = 0;
  socket.cardsInHand = dealHand(images);
  storyteller.push(socket.id);

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

    //removes the played card from the player's hand
    let index = socket.cardsInHand.indexOf(data);
    socket.cardsInHand.splice(index, 1);

    //removes the played card from the array of cards still in the game;
    //if the deck is exhausted, this array is used to prevent duplicates
    //from appearing in the re-generated deck
    cardsPlayersHold.splice(cardsPlayersHold.indexOf(data), 1);

    //adds the played card to a map of cards played this round
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
    //same as above for parseInt
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
    console.log('These are the cards currently in play:')
    console.log(cardsInPlay);
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
    for (let card of socket.cardsInHand) {
      cardsPlayersHold.splice(cardsPlayersHold.indexOf(card), 1);
    }
    io.sockets.emit('playersOnline', {names: playersOnline(players)});
    io.sockets.emit('storyteller', {storyteller: currentStoryteller(players)});
  });
});

http.listen(port, function() {
   console.log('listening on ' + port);
});
