# 基于Unix Socket的可靠Node.js HTTP代理实现（支持WebSocket协议）
运行：
```
npm i

node server.js
```

访问 127.0.0.1:8000即可 （apps目录为子进程业务代码）

## 介绍
实现代理服务，最常见的便是代理服务器代理相应的协议体请求源站，并将响应从源站转发给客户端。而在本文的场景中，代理服务及源服务采用相同技术栈（Node.js），源服务是由代理服务fork出的业务服务（如下图），代理服务不仅负责请求反向代理及转发规则设定，同时也负责业务服务伸缩扩容、日志输出与相关资源监控报警。下文称源服务为**业务服务**。
![enter image description here](https://si.geilicdn.com/vms-0d5900000170bd57c5c80a21924b-unadjust_858_630.png)

最初笔者采用上图的架构，业务服务为真正的HTTP服务或WebSocket服务，其侦听服务器的某个端口并处理代理服务的转发请求。可这有一些问题会困扰我们：
  - 业务服务需要侦听端口，而端口是有上限的且有可能冲突（尽管可以避免冲突）
  - 代理服务转发请求时，又在内核走了一次TCP/IP协议栈解析，且存在性能损耗（TCP的慢启动、ack机制等可靠性保证导致传输性能降低）
  - 转发策略需要与端口耦合，业务移植时存在风险

因此，笔者尝试寻找更优的解决方案。

## 基于Unix Socket协议的HTTP Server
老实说，之前学习linux网络编程的时候从没有尝试基于域套接字的HTTP Server，不过从协议上说，HTTP协议并没有严格要求传输层协议必须为TCP，因此如果底层采用基于字节流的Unix Socket传输，应该也是可以实现要求的。

同时相比较TCP协议实现的可靠传输，Unix Socket作为IPC有些优点：
 - Unix Socket仅仅复制数据，并不执行协议处理，不需要添加或删除网络报头，无需计算校验和，不产生顺序号，也不需要发送确认报文
 - 仅依赖命名管道，不占用端口

> Unix Socket并不是一种协议，它是进程间通信（IPC）的一种方式，解决本机的两个进程通信

在Node.js的http模块和net模块，都提供了相关接口 **“listen(path, cb)”**，不同的是http模块在Unix Socket之上封装了HTTP的协议解析及相关规范，因此这是可以无缝兼容基于TCP实现的HTTP服务的。

下为基于Unix Socket的HTTP Server与Client 样例:
```
const  http  =  require('http');
const  path  =  require('path');
const  fs  =  require('fs');
const  p  =  path.join(__dirname,'tt.sock');

fs.unlinkSync(p);
let  s  =  http.createServer((req, res)=> {
req.setEncoding('utf8')
req.on('data',(d)=>{
	console.log('server get:', d)
});
res.end('helloworld!!!');
});

s.listen(p);

setTimeout(()=>{
	let  c  =  http.request( {
		method:  'post',
		socketPath:  p,
		path:  '/test'
	}, (res) => {
		res.setEncoding('utf8');
		res.on('data', (chunk) => {
			console.log(`响应主体: ${chunk}`);
		});

		res.on('end', () => {
		});
	});
	c.write(JSON.stringify({abc:  '12312312312'}));
	c.end();
},2000)
```
## 代理服务与业务服务进程的创建
代理服务不仅仅是代理请求，同时也负责业务服务进程的创建。在更为高级的需求下，代理服务同时也担负业务服务进程的扩容与伸缩，当业务流量上来时，为了提高业务服务的吞吐量，代理服务需要创建更多的业务服务进程，流量洪峰消散后回收适当的进程资源。透过这个角度会发现这种需求与cluster和child_process模块息息相关，因此下文会介绍业务服务集群的具体实现。

本文中的代理为了实现具有粘性session功能的WebSocket服务，因此采用了child_process模块创建业务进程。这里的粘性session主要指的是Socket.IO的握手报文需要始终与固定的进程进行协商，否则无法建立Socket.IO连接（此处Socket.IO连接特指Socket.IO成功运行之上的连接），具体可见我的文章 [socket.io搭配pm2（cluster）集群解决方案](https://www.cnblogs.com/accordion/p/6930152.html) 。不过，在fork业务进程的时候，会通过pre_hook脚本重写子进程的 **http.Server.listen()** 从而实现基于Unix Socket的底层可靠传输，这种方式则是参考了 cluster 模块对子进程的相关处理，关于cluster模块覆写子进程的listen，可参考我的另一篇文章  [Nodejs cluster模块深入探究](https://www.cnblogs.com/accordion/p/7207740.html) 的“多个子进程与端口复用”一节。

```
// 子进程pre_hook脚本，实现基于Unix Socket可靠传输的HTTP Server
function  setupEnvironment() {
	process.title  =  'ProxyNodeApp: '  +  process['env']['APPNAME'];
	http.Server.prototype.originalListen  =  http.Server.prototype.listen;
	http.Server.prototype.listen  =  installServer;
	loadApplication();
}
function  installServer() {
	var  server  =  this;
	var  listenTries  =  0;
	doListen(server, listenTries, extractCallback(arguments));
	return  server;
}

function  doListen(server, listenTries, callback) {
	function  errorHandler(error) {
		// error handle
	}
	// 生成pipe
	var  socketPath  =  domainPath  =  generateServerSocketPath();
	server.once('error', errorHandler);
	server.originalListen(socketPath, function() {
		server.removeListener('error', errorHandler);
		doneListening(server, callback);
		process.nextTick(finalizeStartup);
	});

	process.send({
		type:  'path',
		path:  socketPath
	});
}
```
这样就完成了业务服务的底层基础设施，到了业务服务的编码阶段无需关注传输层的具体实现，仍然使用 http.Server.listen(${any_port})即可。此时业务服务侦听任何端口都可以，因为在传输层根本没有使用该端口，这样就避免了系统端口的浪费。

## 流量转发
流量转发包括了HTTP请求和WebSocket握手报文，虽然WebSocket握手报文仍然是基于HTTP协议实现，但需要不同的处理，因此这里分开来说。

### HTTP流量转发
此节可参考 “基于Unix Socket的HTTP Server与Client”的示例，在代理服务中新创建基于Unix Socket的HTTP client请求业务服务，同时将响应pipe给客户端。
```
class  Client  extends  EventEmitter{
	constructor(options) {
		super();
		options  =  options  || {};
		this.originHttpSocket  =  options.originHttpSocket;
		this.res  =  options.res;
		this.rej  =  options.rej;
		if (options.socket) {
			this.socket  =  options.socket;
		} else {
			let  self  =  this;
			this.socket  =  http.request({
				method:  self.originHttpSocket.method,
				socketPath:  options.sockPath,
				path:  self.originHttpSocket.url,
				headers:  self.originHttpSocket.headers
			}, (res) => {
				self.originHttpSocket.set(res.headers);
				self.originHttpSocket.res.writeHead(res.statusCode);
				// 代理响应
				res.pipe(self.originHttpSocket.res)
				self.res();
			});
		}
	}
	send() {
		// 代理请求
		this.originHttpSocket.req.pipe(this.socket);
	}
}
// proxy server
const  app  =  new  koa();
app.use(async  ctx  => {
	await  new  Promise((res,rej) => {
		// 代理请求
		let  client  =  new  Client({
			originHttpSocket:  ctx,
			sockPath:  domainPath,
			res,
			rej
		});
		client.send();
	});
});

let  server  =  app.listen(8000);
```

### WebSocket报文处理
如果不做WebSocket报文处理，到此为止采用Socket.IO仅仅可以使用 “polling” 模式，即通过XHR轮询的形式实现假的长连接，WebSocket连接无法建立。因此，如果为了更好性能体验，需要处理WebSocket报文。这里主要参考了“http-proxy”的实现，针对报文做了一些操作：
  1. 头部协议升级字段检查
  2. 基于Unix Socket的协议升级代理请求

报文处理的核心在于第2点：创建一个代理服务与业务服务进程之间的“长连接”（该连接时基于Unix Socket管道的，而非TCP长连接），并使用此连接overlay的HTTP升级请求进行协议升级。

此处实现较为复杂，因此只呈现代理服务的处理，关于WebSocket报文处理的详细过程，可参考 [proxy-based-unixsocket](https://github.com/royalrover/proxy-based-unixsocket)。

```
// 初始化ws模块
wsHandler  =  new  WsHandler({
	target: {
		socketPath:  domainPath
	}
}, (err, req, socket) => {
	console.error(`代理wsHandler出错`, err);
});

// 代理ws协议握手升级
server.on('upgrade',(req, socket, head) =>{
	wsHandler.ws(req, socket, head);
});
```

## 回顾与总结
大家都知道，在Node.js范畴实现HTTP服务集群，应该使用cluster模块而不是“child_process”模块，这是因为采用child_process实现的HTTP服务集群会出现调度上不均匀的问题（内核为了节省上下文切换开销做出来的“优化之举”，详情可参考 [Nodejs cluster模块深入探究](https://www.cnblogs.com/accordion/p/7207740.html)“请求分发策略”一节）。可为何在本文的实现中仍采用child_process模块呢？

答案是：场景不同。作为代理服务，它可以使用cluster模块实现代理服务的集群；而针对业务服务，在session的场景中需要由代理服实现对应的转发策略，其他情况则采用RoundRobin策略即可，因此child_process模块更为合适。

本文并未实现代理服务的负载均衡策略，其实现仍然在 [Nodejs cluster模块深入探究](https://www.cnblogs.com/accordion/p/7207740.html)  中讲述，因此可参阅此文。

最终，在保持进程模型稳定的前提下，变更了底层协议可实现更高性能的代理服务。
![enter image description here](https://si.geilicdn.com/vms-448a00000170c3df9ed40a2262e0-unadjust_910_612.png)