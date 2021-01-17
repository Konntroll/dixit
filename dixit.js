var express = require('express');
var dixit = express();
var http = require('http').Server(dixit);
var io = require('socket.io')(http);
var path = require('path');
var port = process.env.PORT || 80;


dixit.get('/', function(req, res) {
   res.sendFile('dixit.html', {root: __dirname});
}).use(express.static(path.join(__dirname, '/public')));

function populate() {
  let newDeck = [];
  for (let i = 0; i < 80; i++) {
    newDeck.push(i);
  }
  return newDeck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function scoreForTheRound(players) {
  let playerScores = [];
  for (let player of players) {
    playerScores.push(player.player + ' scored ' + player.scoreThisRound + ' points this round');
    player.scoreThisRound = 0;
  }
  return playerScores;
}

var games = new Map();

io.on('connection', function(socket) {
  socket.player = 'unnamed player';
  socket.score = 0;
  socket.scoreThisRound = 0;

  updateGames();

  function updateGames() {
    let currentGames = [];
    for (let game of games.values()) {
      currentGames.push(game.name);
    }
    io.emit('gamesAvailable', currentGames);
  }

  socket.on('startGame', function(game) {
    games.set(game, {
      name: game,
      deck: shuffle(populate()),
      discard: [],
      play: new Map(),
      players: [],
      votes: 0,
      waiting: 0,
      chat: []
    });
    socket.game = games.get(game);
    socket.game.players.push(socket);
    socket.join(game);
    socket.hand = dealHand(socket.game.deck);
    socket.onHold = false;
    socket.emit('newPlayer', socket.hand);
    names(socket.game.players);
    storyteller(socket.game.players[0].player, true);
    updateGames();
  });

  socket.on('newMessage', function(inbound) {
    io.in(socket.game.name).emit('transmit', [socket.player, inbound]);
    socket.game.chat.push([socket.player, inbound]);
    //restricts chat history to 30 player messages
    if (socket.game.chat.length >= 30) {
      socket.game.chat.shift()
    }
  });

  socket.on('joinGame', function(game) {
    socket.broadcast.to(game).emit('joinedTheGame', socket.player);
    socket.game = games.get(game);
    socket.game.players.push(socket);
    socket.join(game);
    socket.hand = dealHand(socket.game.deck);
    if (socket.game.play.size > 0) {
      socket.onHold = true;
      socket.game.waiting++;
    } else {
      socket.onHold = false;
    }
    socket.emit('newPlayer', socket.hand);
    names(socket.game.players);
    storyteller(socket.game.players[0].player, true);
    socket.emit('shareChat', socket.game.chat)
  });

  socket.on('leaveGame', function() {
    socket.broadcast.to(socket.game.name).emit('leftTheGame', socket.player);
    console.log('Players still in game: ' + socket.game.players.length)
    if (socket.game.play.size > 0) {
      midRoundDrop(socket.id);
    }
    if (socket.id == socket.game.players[0].id) {
      socket.game.players.shift();
      if (socket.game.players.length > 0) {
        storyteller(socket.game.players[0].player);
      }
    } else {
      let departed = socket.game.players.indexOf(socket);
      socket.game.players.splice(departed, 1);
    }
    while (socket.hand != 0) {
      socket.game.discard.push(socket.hand.shift());
    }
    if (socket.onHold) {
      socket.game.waiting--;
    }
    socket.leave(socket.game.name);
    socket.score = 0;
    socket.scoreThisRound = 0;
    socket.broadcast.to(socket.game.name).emit('updatePlayers', names(socket.game.players));
    socket.emit('wipe');
    if (socket.game.players.length <= 0) {
      io.emit('closeGame', socket.game.name);
      games.delete(socket.game.name);
      updateGames();
    }
  });

  console.log('User ' + socket.id + ' is online.');

  function midRoundDrop(id) {
    if (id == socket.game.players[0].id) {
      for (let card of socket.game.play.keys()) {
        io.to(socket.game.name).emit('removeFromPlay', card);
      }
      socket.game.play.clear();
      for (let player of socket.game.players) {
        if (player.hand.length < 6) {
          player.hand.push(dealCard(socket.game.deck));
        }  else {
          //this is to check if only one player remains and skips
          //putting the only remaining player on hold as this
          //locks the game up even if new players join
          if (socket.game.players.length != 1) {
            //placeholder solution to a situation where the storyteller
            //leaves mid-play; this is needed for players who haven't
            //played a card to stop the client side from displaying
            //duplicates via the same mechanism as for players on hold
            player.onHold = true;
            socket.game.waiting++;
          }
        }
      }
      socket.broadcast.to(socket.game.name).emit('leftTheBuilding');
    } else {
      for (let card of socket.game.play.keys()) {
        //find the card played by the departing player
        if (socket.game.play.get(card).player == socket.id) {
          //and release the votes cast for that card
          for (let voter of socket.game.play.get(card).voters) {
            io.to(voter).emit('voteReleased');
            socket.game.votes--;
          }
          //remove the departing player's card on the server side
          socket.game.play.delete(card);
          //remove the departing player's card for all players
          //on the client side
          io.to(socket.game.name).emit('removeFromPlay', card);
          //remove all remaining cards for the departing player
          //on the client side
          for (let card of socket.game.play.keys()) {
            socket.emit('removeFromPlay', card);
          }
        }
      }
    }
  }

  socket.on('playCard', function(data) {
    //  - socket.game.waiting !
    if (socket.game.players.length < 3) {
      socket.emit('needMorePlayers', data);
      return;
    }
    if (socket.onHold == true) {
      socket.emit('holdPlay', data);
      return;
    }
    if (socket.id != socket.game.players[0].id && socket.game.play.size <= 0) {
      socket.emit('wait', data);
      return;
    }
    for (let card of socket.game.play.values()) {
      if (card.player == socket.id) {
        socket.emit('alreadyPlayed', data);
        return;
      }
    }

    //removes the played card from the player's hand
    let index = socket.hand.indexOf(data);
    socket.hand.splice(index, 1);

    //removes the played card from the array of cards still in the game;
    //if the deck is exhausted, this array is used to prevent duplicates
    //from appearing in the re-generated deck
    //socket.game.cardsPlayersHold.splice(cardsPlayersHold.indexOf(data), 1);

    //discard the played card to be reused if the deck is exhausted
    socket.game.discard.push(data);

    //adds the played card to a map of cards played this round
    socket.game.play.set(data, {
      player: socket.id,
      voters: []
    });
    if (socket.game.play.size == socket.game.players.length - socket.game.waiting) {
      io.to(socket.game.name).emit('cardsPlayed', shuffle([...socket.game.play.keys()]));
    }
  });

  socket.on('vote', function(data) {
    if (socket.onHold == true) {
      socket.emit('holdVote');
      return;
    }
    for (let card of socket.game.play.values()) {
      if (card.voters.indexOf(socket.id) >= 0) {
        socket.emit('alreadyVoted');
        return;
      }
    }
    if (socket.id == socket.game.players[0].id) {
      socket.emit('noVote');
      return;
    }
    //data is an HTML id property of the image being voted for,
    //hence it is a string and needs to be converted to integer
    //to work as a key for the map of cards in play
    if (socket.game.play.get(parseInt(data)).player == socket.id) {
      socket.emit('autoVote');
      return;
    }
    //same as above for parseInt()
    socket.game.play.get(parseInt(data)).voters.push(socket.id);
    socket.game.votes++;
    if (socket.game.votes >= socket.game.play.size - 1) {
      tallyVotes();
      io.to(socket.game.name).emit('scoreUpdate', {scores: scoreForTheRound(socket.game.players)});
      prepForNextRound();
      for (let player of socket.game.players) {
        player.scoreThisRound = 0;
      }
      socket.game.votes = 0;
    }
  });

  socket.on('readyForNextRound', function() {
    if (!socket.onHold) {
      socket.emit('nextRound', socket.hand[socket.hand.length - 1]);
    } else {
      socket.emit('nextRound', -1);
      socket.onHold = false;
      socket.game.waiting--;
    }
  });

  function tallyVotes() {
    for (let card of socket.game.play.values()) {
      if (card.player == socket.game.players[0].id) {
        if (card.voters.length == 0 || card.voters.length >= socket.game.play.size - 1) {
          for (let player of socket.game.players) {
            if (player.id != socket.game.players[0].id && player.onHold != true) {
              player.score += 2;
              player.scoreThisRound += 2;
            }
          }
          return;
        } else {
          socket.game.players[0].score += 3;
          socket.game.players[0].scoreThisRound += 3;
          for (let voter of card.voters) {
            for (let player of socket.game.players) {
              if (player.id == voter) {
                player.score += 3;
                player.scoreThisRound += 3;
              }
            }
          }
        }
      } else {
        for (let player of socket.game.players) {
          if (player.id == card.player) {
            player.score += card.voters.length;
            player.scoreThisRound += card.voters.length;
          }
        }
      }
    }
  }

  function prepForNextRound() {
    socket.game.players.push(socket.game.players.shift());
    names(socket.game.players);
    storyteller(socket.game.players[0].player);
    socket.game.play.clear();
    for (let player of socket.game.players) {
      if (player.hand.length < 6) {
        player.hand.push(dealCard(socket.game.deck));
      }
    }
  }

  socket.on('assignName', function(data) {
    if (data.match(/dixit/i)) {
      socket.emit('nameTaken');
      return;
    }
    for (let player of io.sockets.sockets.values()) {
      let re = new RegExp(player.player, 'i');
      if (data.match(re)) {
        socket.emit('nameTaken');
        return;
      }
    }
    socket.player = data;
    socket.emit('welcome');
    /*if (socket.game) {
      names(socket.game.players);
    }*/
  });

  socket.on('disconnect', function() {
    console.log('User ' + socket.id + ' is offline.');
    /*socket.broadcast.to(socket.game.name).emit('leftTheGame', socket.player);
    if (socket.game.play.size > 0) {
      midRoundDrop(socket.id);
    }
    if (socket.id == socket.game.players[0].id) {
      socket.game.players.shift();
      if (socket.game.players.length > 0) {
        storyteller(socket.game.players[0].player);
      }
    } else {
      let departed = socket.game.players.indexOf(socket);
      socket.game.players.splice(departed, 1);
    }
    while (socket.hand.length != 0) {
      socket.game.discard.push(socket.hand.shift())
    }
    if (socket.onHold == true) {
      socket.game.waiting--;
    }
    if (socket.game.players.length <= 0) {
      io.emit('closeGame', socket.game.name);
      games.delete(socket.game.name);
    }
    names(socket.game.players);
    if (socket.game.players.length <= 0) {
      io.emit('closeGame', socket.game.name);
      games.delete(socket.game.name);
      updateGames();
    }*/
  });

  function names(players) {
    if (players.length <= 0) {
      return console.log('Nobody there anymore!');
    }
    let data = {
      names: [],
      scores: []
    }
    for (let player of players) {
      data.names.push(player.player);
      data.scores.push(player.score);
    }
    io.to(socket.game.name).emit('playersOnline', data);
  }

  function storyteller(player, newJoin = false) {
    if (newJoin) {
      socket.emit('storyteller', player);
    } else {
      io.to(socket.game.name).emit('storyteller', player);
    }
  }

  function dealHand(array) {
    if (array.length < 6) {
      array = array.concat(shuffle(socket.game.discard));
      socket.game.discard = [];
    }
    return array.splice(0, 6);
  }

  function dealCard(array) {
    if (array.length < 1) {
      array = array.concat(shuffle(socket.game.discard));
      socket.game.discard = [];
    }
    return array.shift();
  }
});

http.listen(port, function() {
   console.log('Listening on port ' + port);
});
