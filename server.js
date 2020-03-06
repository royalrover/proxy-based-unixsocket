let koa = require('koa');
let http = require('http');
let { EventEmitter } = require('events'); 
let { fork } = require('./lib/util');
let { WsHandler } = require('./lib/wsProxy');

class Client extends EventEmitter{
    constructor(options) {
        super();
        options = options || {};
        this.originHttpSocket = options.originHttpSocket;
        this.res = options.res;
        this.rej = options.rej;
        
        if (options.socket) {
            this.socket = options.socket;
        } else {
            let self = this;
            this.socket = http.request({
                method: self.originHttpSocket.method,
                socketPath: options.sockPath,
                path: self.originHttpSocket.url,
                headers: self.originHttpSocket.headers
            }, (res) => {
                self.originHttpSocket.set(res.headers);
                self.originHttpSocket.set('Access-Control-Allow-Origin', '*')
                self.originHttpSocket.res.writeHead(res.statusCode);
                res.pipe(self.originHttpSocket.res)
                self.res();
            });
        }
    }
  
    send() {
        this.originHttpSocket.req.pipe(this.socket);
    }
}

async function init() {
    let data = await fork('ws_demo');
    let domainPath = data.path;

    const app = new koa();

    app.use(async ctx => {
        await new Promise((res,rej) => {
            let client = new Client({
                originHttpSocket: ctx,
                sockPath: domainPath,
                res,
                rej
            });
            client.send();
        });
    });

    let server = app.listen(8000);
    // 初始化ws模块
    wsHandler = new WsHandler({
        target: {
            socketPath: domainPath
        }
    }, (err, req, socket) => {
        console.error(`代理wsHandler出错`, err);
    });

    // 代理ws协议握手升级
    server.on('upgrade',(req, socket, head) =>{
        wsHandler.ws(req, socket, head);
    });
}

init();
