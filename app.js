var express = require('express');
var socketio = require('socket.io');
var redis = require('redis-url');
var connect = require('connect');

/* redis */
var redis_client = redis.createClient(process.env.REDISTOGO_URL);
redis_client.on('error', function (err) {
	console.log('Error: ' + err);
});

redis_client.nameExists = function(name, trueCallback, falseCallback) {
	this.exists(name, function(error, result) {
		if (error) console.log('Redis Error (at exists): ' + error);
		else if (result) trueCallback.call(result);
		else falseCallback.call();
	});
}

/* express */
var app = express.createServer();
var port = process.env.PORT || 3000;
app.listen(port);
app.use(express.bodyParser());
app.use(express.cookieParser());
app.use(express.static(__dirname + '/public'));
var store = new (connect.session.MemoryStore)();
app.use(express.session({
	store: store,
	secret: '******',
	cookie: { httpOnly: false}
}));
app.get('/', function(req, res) {
	var name = req.cookies.name;
	redis_client.nameExists(name, function(result) {
		res.render('room.ejs', {
			name: name
		});
	}, function() {
		res.render('index.ejs');
	});
});
app.get('/register_page', function(req, res) {
	res.render('register.ejs');
});
app.post('/register', function(req, res) {
	var name = req.body.name;
	var pass = req.body.pass;
	redis_client.nameExists(name, function(result) {
		res.render('register.ejs', {
			registerMsg: name + 'is already used'
		});
	}, function() {
		var user = {"name": name, "pass": pass}
		redis_client.set(name, JSON.stringify(user), function(err, result) {
			if(err) console.log('Redis Error(on /register at set): ' + err);
		});
		res.render('index.ejs');
	});
});
app.post('/login', function(req, res) {
	var params = req.body;
	var pass = req.body.pass;
	redis_client.nameExists(params.name, function(result) {
		redis_client.get(params.name, function(err, result) {
			if(err) console.log('Redis Error(on /login get at login): ' + err)
			else {
				if(params.pass!=JSON.parse(result.toString())['pass']) {
					res.render('index.ejs', {
						loginMsg: params.name + '\'s password is incorrect'
					});
				}
				else {
					/* login successful */
					res.cookie('name', params.name);
					res.render('room.ejs', {
						name: params.name
					});
				}
			}
		});
	}, function() {
		res.render('index.ejs', {
			loginMsg: params.name + ' is not registered'
		});
	});
});
app.get('/logout', function(req, res) {
	res.cookie('name', '');
	res.render('index.ejs');
});
app.get('/chat', function(req, res) {
	res.render('chat.ejs', {
		name: req.cookies['name'],
		dst: req.query.dst
	});
});

/* socket.io */
var io = socketio.listen(app);
io.configure(function() {
	io.set('authorization', function(handshakeData, callback) {
		var cookie = handshakeData.headers.cookie;
		if(cookie) {
			var sessionID = connect.utils.parseCookie(cookie)['connect.sid'];
			handshakeData.cookie = cookie;
			handshakeData.sessionID = sessionID;
			handshakeData.sessionStore = store;
			store.get(sessionID, function(err, session) {
				if(err) callback(err.message, false);
				else {
					handshakeData.session = new connect.middleware.session.Session(handshakeData, session);
					callback(null, true);
				}
			});
		}
		else {
			return callback('Cookie is not found', false);
		}
	});
});
var clients = [];
io.sockets.on('connection', function(socket) {
	var handshake = socket.handshake;
	var intervalID = setInterval(function() {
		handshake.session.reload(function() {
			handshake.session.touch().save();
		});
	}, 1000*2);
	var cookie = connect.utils.parseCookie(handshake.cookie);
	var name = cookie['name'];
	var hist_head = 0;

	socket.on('enter room', function() {
		cookie['room'] = 'public';
		socket.join('public');
		clients[name] = socket;
		redis_client.sadd('login_users', name, function(err, result) {
			if(err) console.log('Redis Error(on enter room at sadd): ' + err);
		});
		redis_client.smembers('login_users', function(err, result) {
			if(err) console.log('Redis Error(on enter room at smembers): ' + err);
			var user_list = result.toString().split(',');
			socket.emit('update user list', user_list);
			socket.broadcast.emit('update user list', user_list);
		});
	});

	socket.on('enter chatroom', function(room_name) {
		cookie['room'] = room_name;
		socket.join(room_name);
		redis_client.sadd(name + '_room', room_name, function(err, result) {
			if(err) console.log('Redis Error(on enter chatroom at sadd): ' + err);
		});
		redis_client.llen('room_' + room_name, function(err, count) {
			if(err) console.log('Redis Error(on enter chatroom at llen): ' + err);
			else {
				hist_head = count-1;
				redis_client.lrange('room_' + room_name, (hist_head<9)?0:(hist_head-9), hist_head, function(err, result) {
					if(err) console.log('Redis Error(on enter chatroom at lrange): ' + err);
					else {
						hist_head = (hist_head<9)?0:(hist_head-10);
						socket.emit('get history', result);
					}
				});
			}
		});
	});

	socket.on('send message', function(msg, dst) {
		var shared_message = name + ' : ' + msg + ' (' + getDate() + ')';
		var roomname = getRoomName(name, dst);
		io.sockets.in(roomname).send(shared_message);
		redis_client.sismember(dst + '_room', roomname, function(error, result) {
			if(error) console.log('Redis Error(on send message at sismember): ' + error);
			else if(!result) {
				if(clients[dst]) clients[dst].send(shared_message);
			}
		});
		/* save message */
		redis_client.rpush('room_' + getRoomName(name, dst), shared_message, function(err, result) {
			if(err) console.log('Redis Error(on send message at lpush): ' + err);
		});
	});

	socket.on('get history', function(room_name) {
		redis_client.lrange('room_' + room_name, (hist_head<9)?0:(hist_head-9), hist_head, function(err, result) {
			if(err) console.log('Redis Error(on get history at lrange): ' + err);
			else {
				hist_head = (hist_head<9)?0:(hist_head-10);
				socket.emit('get history', result);
			}
		});
	});

	socket.on('disconnect', function() {
		clearInterval(intervalID);
		var room_name = cookie['room'];
		/* leave from room */
		if(room_name=='public'){
			redis_client.srem('login_users', name, function(err, result) {
				if(err) console.log('Redis Error(on disconnect at srem): ' + err);
			});
			redis_client.smembers('login_users', function(err, result) {
				if(err) console.log('Redis Error(on disconnect at smembers): ' + err);
				else {
					socket.broadcast.emit('update user list', result.toString().split(','));
				}
			});
			clients[name] = null;
			socket.leave(room_name);
		}
		/* leave from chatroom */
		else if(room_name){
			redis_client.srem(name + '_room', room_name, function(err, result) {
				if(err) console.log('Redis Error(on disconnect at srem): ' + err);
			});
			socket.leave(room_name);
		}
	});
});

function getRoomName(name, dst) {
	if(name > dst)
		return (dst + '_' + name);
	else
		return (name + '_' + dst);
}

function getDate() {
	var date = new Date();
	var day = date.getFullYear() + '/' + (date.getMonth()+1) + '/' + date.getDate();
	var h = date.getHours();
	if(h<10)h='0'+h;
	var m = date.getMinutes();
	if(m<10)m='0'+m;
	var s = date.getSeconds();
	if(s<10)s='0'+s;
	var time = h + ':' + m + ':' + s;
	return day + ' ' + time;
}
