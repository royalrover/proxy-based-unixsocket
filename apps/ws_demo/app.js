var server = require('http').createServer(handler);
var io = require('socket.io').listen(server);
var fs = require('fs');

// 此处并没有真正侦听端口
let a = server.listen(3001);
console.log('Socket.io demo listening on http://0.0.0.0:' + server.address().port);

function lookupFile(req) {
	var name;
	if (req.url == '/') {
		name = '/index.html';
	} else {
		name = req.url;
	}
	return __dirname + '/public' + name;
}

function handler(req, res) {
	return new Promise((reso,rej) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end',() => {
			try {
				var filename = lookupFile(req);
				fs.readFile(filename, function (err, data) {
					if (err) {
						res.writeHead(200);
						res.end(JSON.stringify({
							type: 'reverse',
							data: body
						}));
						reso()
					} else {
						res.writeHead(200);
						res.end(data);
						reso()
					}
				});
			} catch(e) {
				console.error(e)
			}	
		});
	});
	
}

io.sockets.on('connection', function (socket) {
	setInterval(function() {
		socket.emit('news', { message: new Date() + '' });
	}, 1000);

	socket.on('message', function(data) {
		console.log('receie data', data);
		socket.emit('news', { message: "The server received your message: \"" + data + "\"" });
	});
});
