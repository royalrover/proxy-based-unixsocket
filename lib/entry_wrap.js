var EventEmitter = require('events').EventEmitter;
var os = require('os');
var fs = require('fs');
var http = require('http');
var util = require('util');
var args = process.argv;
var appName = args[2];
var nodeClusterErrCount = 0;

function badPackageError(packageName) {
	return "You required the " + packageName + ", which is incompatible with Passenger, a non-functional shim was returned and your app may still work. However, please remove the related code as soon as possible.";
}

// Logs failure to install shim + extended debug info, but with strict spamming protection.
function errorMockingRequire(packageName, error, args, count) {
	if (count > 2) {
		return; // spam protect against repeated warnings
	}
	var msg = "Failed to install shim to guard against the " + packageName + ". Due to: " + error.message + ". Your can safely ignore this warning if you are not using " + packageName;
	msg += "\n\tNode version: " + process.version + "\tArguments: " + args.length;
	for (i = 0; i < args.length; i++) {
		if (i > 9) { // limit the amount of array elements we log
			break;
		}
		msg += "\n\t[" + i + "] " + util.inspect(args[i]).substr(0, 200); // limit the characters per array element
	};
	console.error(msg);
}

//Mock out Node Cluster Module
var Module = require('module');
var originalRequire = Module.prototype.require;
Module.prototype.require = function() {
	try {
		if (arguments['0'] == 'cluster') {
			console.trace(badPackageError("Node Cluster module"));
			return {
				disconnect		 : function(){return false;},
				fork			 : function(){return false;},
				setupMaster		 : function(){return false;},
				isWorker		 : true,
				isMaster		 : false,
				schedulingPolicy : false,
				settings		 : false,
				worker			 : false,
				workers			 : false,
			};
		}
	} catch (e) {
		nodeClusterErrCount++;
		errorMockingRequire("Node Cluster module", e, arguments, nodeClusterErrCount);
	}
	return originalRequire.apply(this, arguments);
};

module.isApplicationLoader = true; // https://groups.google.com/forum/#!topic/compoundjs/4txxkNtROQg

function setupEnvironment() {
	process.title = 'ProxyNodeApp: ' + process['env']['APPNAME'];
	http.Server.prototype.originalListen = http.Server.prototype.listen;
    http.Server.prototype.listen = installServer;
    
	loadApplication();
}

function loadApplication() {
    var appRoot = process.cwd();
    var startupFile = appRoot + '/' + 'app.js';
	require(startupFile);
}

function extractCallback(args) {
	if (args.length > 1 && typeof(args[args.length - 1]) == 'function') {
		return args[args.length - 1];
	}
}

function generateServerSocketPath() {
	var socketDir, socketPrefix, socketSuffix;

    socketDir = os.tmpdir().replace(/\/$/, '');
    socketPrefix = "PsgNodeApp";
	socketSuffix = ((Math.random() * 0xFFFFFFFF) & 0xFFFFFFF);

	var result = socketDir + "/" + socketPrefix + "." + socketSuffix.toString(36);
	var UNIX_PATH_MAX = 100;
	return result.substr(0, UNIX_PATH_MAX);
}

function addListenerAtBeginning(emitter, event, callback) {
	var listeners = emitter.listeners(event);
	var i;

	emitter.removeAllListeners(event);
	emitter.on(event, callback);
	for (i = 0; i < listeners.length; i++) {
		emitter.on(event, listeners[i]);
	}
}

var domainPath;
function doListen(server, listenTries, callback) {
	function errorHandler(error) {
		if (error.errno == 'EADDRINUSE') {
			if (listenTries == 100) {
				server.emit('error', new Error(
					'Phusion Passenger could not find suitable socket address to bind on'));
			} else {
				// Try again with another socket path.
				listenTries++;
				doListen(server, listenTries, callback);
			}
		} else {
			server.emit('error', error);
		}
	}

	var socketPath = domainPath =  generateServerSocketPath();
	server.once('error', errorHandler);
	server.originalListen(socketPath, function() {
		server.removeListener('error', errorHandler);
		doneListening(server, callback);
		process.nextTick(finalizeStartup);
    });
    process.send({
        type: 'path',
        path: socketPath
    });
}

function doneListening(server, callback) {
	if (callback) {
		server.once('listening', callback);
	}
	server.emit('listening');
}

function installServer() {
	var server = this;
    addListenerAtBeginning(server, 'request', function(req) {
        req.connection.__defineGetter__('remoteAddress', function() {
            return '127.0.0.1';
        });
        req.connection.__defineGetter__('remotePort', function() {
            return 0;
        });
    });

    var listenTries = 0;
    doListen(server, listenTries, extractCallback(arguments));

    return server;
}

function finalizeStartup() {
	var workDir = process.env['PASSENGER_SPAWN_WORK_DIR'];
    console.log(`应用${appName}启动成功，信息如下：`,{
		sockets: [
			{
				name: 'main',
				address: 'unix:' + domainPath,
				protocol: 'http',
				concurrency: 0,
				accept_http_requests: true
			}
		]
	});
}

setupEnvironment();