let util = exports,
    url = require('url'),
    extend = require('util')._extend,
    cp = require('child_process'),
    path = require('path');

let upgradeHeader = /(^|,)\s*upgrade\s*($|,)/i,
    isSSL = /^https|wss/;

util.fork = async (appName) => {
    let entryPath = path.join(__dirname, './entry_wrap.js');
    let pro = cp.fork(entryPath, [appName], {
        cwd: path.join(process.cwd(), `apps/${appName}`),
        env: {
            APPNAME: appName
        },
        // execArgv: ['--inspect-brk=9999'],
        stdio: 'pipe'
    });

    return new Promise((res, rej) => {
        pro.stdout.on('data', (data) =>{
            console.log('child app stdout: ', data.toString());
        });
    
        pro.stderr.on('data', (data) =>{
            console.log('child app stderr: ', data.toString());
        });
    
        pro.on('message', (d) => {
            if (d.type == 'path') {
                res(d);
            }
        });
        pro.on('error', (e) =>{
            rej(e);
        });
    });
}

util.isSSL = isSSL;

util.setupOutgoing = function(outgoing, options, req, forward) {
    // 源wsserver是基于unix socket，而不走tcp/ip协议栈
    // 不能有host或port
//   outgoing.port = options[forward || 'target'].port ||
//                   (isSSL.test(options[forward || 'target'].protocol) ? 443 : 80);

  ['socketPath', 'pfx', 'key',
    'passphrase', 'cert', 'ca', 'ciphers', 'secureProtocol'].forEach(
    function(e) { outgoing[e] = options[forward || 'target'][e]; }
  );

  outgoing.method = options.method || req.method;
  outgoing.headers = extend({}, req.headers);

  if (options.headers){
    extend(outgoing.headers, options.headers);
  }

  if (options.auth) {
    outgoing.auth = options.auth;
  }
  
  if (options.ca) {
      outgoing.ca = options.ca;
  }

  if (isSSL.test(options[forward || 'target'].protocol)) {
    outgoing.rejectUnauthorized = (typeof options.secure === "undefined") ? true : options.secure;
  }


  outgoing.agent = options.agent || false;
  outgoing.localAddress = options.localAddress;

  if (!outgoing.agent) {
    outgoing.headers = outgoing.headers || {};
    if (typeof outgoing.headers.connection !== 'string'
        || !upgradeHeader.test(outgoing.headers.connection)
       ) { outgoing.headers.connection = 'close'; }
  }


  var target = options[forward || 'target'];
  var targetPath = target && options.prependPath !== false
    ? (target.path || '')
    : '';

  var outgoingPath = !options.toProxy
    ? (url.parse(req.url).path || '')
    : req.url;

  outgoingPath = !options.ignorePath ? outgoingPath : '';

  outgoing.path = util.urlJoin(targetPath, outgoingPath);
  return outgoing;
};


util.setupSocket = function(socket) {
  socket.setTimeout(0);
  socket.setNoDelay(true);

  socket.setKeepAlive(true, 0);

  return socket;
};

util.getPort = function(req) {
  var res = req.headers.host ? req.headers.host.match(/:(\d+)/) : '';

  return res ?
    res[1] :
    util.hasEncryptedConnection(req) ? '443' : '80';
};

util.hasEncryptedConnection = function(req) {
  return Boolean(req.connection.encrypted || req.connection.pair);
};

util.urlJoin = function() {
    //
    // We do not want to mess with the query string. All we want to touch is the path.
    //
  var args = Array.prototype.slice.call(arguments),
      lastIndex = args.length - 1,
      last = args[lastIndex],
      lastSegs = last.split('?'),
      retSegs;

  args[lastIndex] = lastSegs.shift();

  retSegs = [
    args.filter(Boolean).join('/')
        .replace(/\/+/g, '/')
        .replace('http:/', 'http://')
        .replace('https:/', 'https://')
  ];
  retSegs.push.apply(retSegs, lastSegs);

  return retSegs.join('?')
};

util.rewriteCookieProperty = function rewriteCookieProperty(header, config, property) {
  if (Array.isArray(header)) {
    return header.map(function (headerElement) {
      return rewriteCookieProperty(headerElement, config, property);
    });
  }
  return header.replace(new RegExp("(;\\s*" + property + "=)([^;]+)", 'i'), function(match, prefix, previousValue) {
    var newValue;
    if (previousValue in config) {
      newValue = config[previousValue];
    } else if ('*' in config) {
      newValue = config['*'];
    } else {
      //no match, return previous value
      return match;
    }
    if (newValue) {
      //replace value
      return prefix + newValue;
    } else {
      //remove value
      return '';
    }
  });
};
