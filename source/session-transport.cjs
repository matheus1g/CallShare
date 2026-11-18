// Original CallShare transport. Uses Node built-ins only; no account/token parsing.
class SessionTransport {
    constructor({root, onStatus = () => {}, scope = "gateway"}) {
        this.root = root;
        this.onStatus = onStatus;
        this.status = "desligada";
        this.sockets = new Set();
        this.stopped = false;
        this.routed = 0;
        this.scope = scope === "rtc" ? "rtc" : "gateway";
        this.net = require("net");
        this.http = require("http");
        this.tls = require("tls");
        this.crypto = require("crypto");
        this.fs = require("fs");
        this.path = require("path");
        this.cp = require("child_process");
    }

    state(value) { this.status = value; this.onStatus(value); }

    static gateway(value) {
        try {
            const url = new URL(value);
            return url.protocol === "wss:" && /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) &&
                (!url.port || url.port === "443") && !url.username && !url.password &&
                url.pathname === "/" && !url.hash ? url : null;
        } catch { return null; }
    }

    static rtc(value) {
        // Follow the RTC endpoint port while retaining the Discord host/TLS boundary.
        try {
            const url = new URL(value);
            return url.protocol === "wss:" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.discord\.media$/.test(url.hostname) &&
                (!url.port || Number(url.port) > 0) && !url.username && !url.password &&
                url.pathname === "/" && !url.hash ? url : null;
        } catch { return null; }
    }

    target(value) { return SessionTransport.gateway(value) || (this.scope === "rtc" ? SessionTransport.rtc(value) : null); }

    track(socket) {
        this.sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => this.sockets.delete(socket));
        return socket;
    }

    async freePort() {
        const server = this.net.createServer();
        return new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const port = server.address().port;
                server.close(error => error ? reject(error) : resolve(port));
            });
        });
    }

    async start() {
        if (this.starting || this.server || this.stopped) throw new Error("estado da rota inválido");
        this.starting = true;
        try {
            this.failureStage = "verify";
            const executable = this.path.join(this.root, "tor", "tor.exe");
            const expected = "8c38513b3c4584154158e7c584f4144849dc679a64cd679553d72dad28230c54";
            if (!this.fs.existsSync(executable) || this.crypto.createHash("sha256")
                .update(this.fs.readFileSync(executable)).digest("hex") !== expected)
                throw new Error("pacote Tor ausente ou diferente da versão verificada");
            this.failureStage = "bind";
            this.socksPort = await this.freePort();
            if (this.stopped) throw new Error("operação cancelada");
            // Separate profile; never controls a Tor process the plugin did not create.
            this.failureStage = "profile";
            const data = this.path.join(this.root, "state");
            this.fs.mkdirSync(data, {recursive: true});
            const args = ["--ignore-missing-torrc", "-f", this.path.join(data, "callshare-unused-torrc"),
                "--DataDirectory", data, "--SocksPort", `127.0.0.1:${this.socksPort}`,
                "--GeoIPFile", this.path.join(this.root, "data", "geoip"),
                "--GeoIPv6File", this.path.join(this.root, "data", "geoip6"),
                "--ExcludeExitNodes", "{br}", "--StrictNodes", "1", "--ClientOnly", "1",
                "--SafeSocks", "1", "--Log", "notice stdout", "--AvoidDiskWrites", "1"];
            this.failureStage = "bootstrap";
            this.state("preparando Tor 0%");
            await new Promise((resolve, reject) => {
                let finished = false, pending = "";
                const finish = error => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(this.bootTimer);
                    this.cancelBoot = null;
                    error ? reject(error) : resolve();
                };
                this.cancelBoot = () => finish(new Error("operação cancelada"));
                const child = this.child = this.cp.spawn(executable, args,
                    {cwd: this.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
                child.stderr.on("data", () => {}); // Drain, never persist raw Tor messages.
                child.stdout.on("data", chunk => {
                    pending = (pending + chunk.toString("utf8")).slice(-8192);
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop();
                    for (const line of lines) {
                        const match = /Bootstrapped (\d{1,3})%/.exec(line);
                        if (match && !this.stopped) {
                            const progress = Math.min(100, Number(match[1]));
                            this.state(`preparando Tor ${progress}%`);
                            if (progress === 100) finish();
                        }
                    }
                });
                child.once("error", () => finish(new Error("não foi possível iniciar o Tor integrado")));
                child.once("exit", () => {
                    finish(new Error("Tor encerrou antes de concluir"));
                    if (!this.stopped) { this.state("Tor encerrou; rota indisponível"); this.stop(); }
                });
                this.bootTimer = setTimeout(() => finish(new Error("Tor não conectou em 150 segundos")), 150000);
            });
            if (this.stopped) throw new Error("operação cancelada");
            // Probe TLS + WebSocket HELLO with no Discord credentials before touching its session.
            this.failureStage = "probe";
            this.state("verificando acesso ao Discord");
            await this.probeGateway();
            if (this.stopped) throw new Error("operação cancelada");
            this.failureStage = "bridge";
            await this.listen();
            if (this.stopped) throw new Error("operação cancelada");
            this.state("Tor pronto; aguardando nova sessão");
            this.failureStage = null;
        } catch (error) { this.stop(); throw error; }
        finally { this.starting = false; }
    }

    async socks(host, port = 443) {
        if (this.stopped || !this.target(`wss://${host}:${port}/`)) throw new Error("destino recusado");
        const socket = this.track(this.net.connect({host: "127.0.0.1", port: this.socksPort}));
        return new Promise((resolve, reject) => {
            let stage = 0, buffer = Buffer.alloc(0), settled = false;
            const timer = setTimeout(() => fail(), 40000);
            const cleanup = () => {
                clearTimeout(timer); socket.removeListener("data", read);
                socket.removeListener("error", fail); socket.removeListener("close", fail);
            };
            const fail = () => {
                if (settled) return;
                settled = true; cleanup(); socket.destroy(); reject(new Error("conexão Tor recusada ou sem resposta"));
            };
            const read = chunk => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > 1024) return fail();
                if (stage === 0 && buffer.length >= 2) {
                    if (buffer[0] !== 5 || buffer[1] !== 0) return fail();
                    buffer = buffer.subarray(2); stage = 1;
                    const name = Buffer.from(host, "ascii"), end = Buffer.alloc(2); end.writeUInt16BE(port);
                    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, end]));
                }
                if (stage === 1 && buffer.length >= 5) {
                    if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[2] !== 0) return fail();
                    const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 :
                        buffer[3] === 3 ? 7 + buffer[4] : 0;
                    if (!length) return fail();
                    if (buffer.length < length) return;
                    // TLS is client-first; unexpected bytes before ClientHello are refused.
                    if (buffer.length !== length || this.stopped) return fail();
                    settled = true; cleanup(); socket.pause(); resolve(socket);
                }
            };
            socket.once("error", fail); socket.once("close", fail); socket.on("data", read);
            socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
        });
    }

    async secure(host, port = 443) {
        const raw = await this.socks(host, port);
        if (this.stopped) { raw.destroy(); throw new Error("operação cancelada"); }
        const socket = this.track(this.tls.connect({socket: raw, servername: host, rejectUnauthorized: true,
            minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"]}));
        raw.resume();
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => fail(), 20000);
            const cleanup = () => { clearTimeout(timer); socket.removeListener("error", fail); socket.removeListener("close", fail); };
            const fail = () => { if (settled) return; settled = true; cleanup(); socket.destroy(); reject(new Error("TLS do Discord não foi validado")); };
            socket.once("error", fail);
            socket.once("close", fail);
            socket.once("secureConnect", () => {
                if (this.stopped || !socket.authorized) return fail();
                if (settled) return;
                settled = true; cleanup();
                resolve(socket);
            });
        });
    }

    request(url, key, protocols, extensions) {
        const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`,
            "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13", "Origin: https://discord.com"];
        if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols}`);
        if (extensions) lines.push(`Sec-WebSocket-Extensions: ${extensions}`);
        return lines.join("\r\n") + "\r\n\r\n";
    }

    async handshake(url, key, protocols, extensions) {
        const socket = await this.secure(url.hostname, Number(url.port || 443));
        return new Promise((resolve, reject) => {
            let buffer = Buffer.alloc(0), settled = false;
            const timer = setTimeout(() => fail(), 25000);
            const cleanup = () => {
                clearTimeout(timer); socket.removeListener("data", read);
                socket.removeListener("error", fail); socket.removeListener("close", fail);
            };
            const fail = () => {
                if (settled) return;
                settled = true; cleanup(); socket.destroy(); reject(new Error("gateway não aceitou a rota Tor"));
            };
            const read = chunk => {
                buffer = Buffer.concat([buffer, chunk]);
                const end = buffer.indexOf("\r\n\r\n");
                if (end < 0) { if (buffer.length > 16384) fail(); return; }
                if (end > 16384) return fail();
                const header = buffer.subarray(0, end + 4).toString("latin1");
                const accept = this.crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
                const match = /^sec-websocket-accept:\s*([^\r\n]+)\s*$/im.exec(header);
                if (!/^HTTP\/1\.1 101\b/.test(header) || !match || match[1].trim() !== accept || this.stopped) return fail();
                settled = true; cleanup(); socket.pause(); resolve({socket, buffer});
            };
            socket.once("error", fail); socket.once("close", fail); socket.on("data", read);
            socket.write(this.request(url, key, protocols, extensions));
            socket.resume();
        });
    }

    async probeGateway() {
        const key = this.crypto.randomBytes(16).toString("base64");
        const result = await this.handshake(new URL("wss://gateway.discord.gg/?v=10&encoding=json"), key);
        result.socket.destroy();
    }

    async listen() {
        this.nonce = this.crypto.randomBytes(32).toString("hex");
        this.server = this.http.createServer({maxHeaderSize: 16384}, (_req, res) => {
            res.writeHead(404, {"Connection": "close"}); res.end();
        });
        this.server.maxConnections = 8;
        this.server.on("connection", socket => { this.track(socket); socket.setTimeout(65000, () => socket.destroy()); });
        this.server.on("clientError", (_error, socket) => socket.destroy());
        this.server.on("upgrade", (req, client, head) => this.upgrade(req, client, head));
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", resolve);
        });
        this.port = this.server.address().port;
        this.server.on("error", () => { if (!this.stopped) { this.state("ponte local indisponível"); this.stop(); } });
    }

    async upgrade(req, client, head) {
        try {
            if (this.stopped || req.headers.host !== `127.0.0.1:${this.port}` ||
                req.method !== "GET" || req.headers.origin !== "https://discord.com" ||
                req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" ||
                !/^[A-Za-z0-9+/]{22}==$/.test(req.headers["sec-websocket-key"] || "")) throw new Error();
            const local = new URL(req.url, "http://127.0.0.1");
            if (local.pathname !== `/${this.nonce}` || [...local.searchParams.keys()].join() !== "target") throw new Error();
            const target = this.target(local.searchParams.get("target"));
            if (!target || target.href.length > 2048) throw new Error();
            client.pause();
            const {socket, buffer} = await this.handshake(target, req.headers["sec-websocket-key"],
                req.headers["sec-websocket-protocol"], req.headers["sec-websocket-extensions"]);
            if (this.stopped || client.destroyed) { socket.destroy(); throw new Error(); }
            client.setTimeout(0);
            client.once("close", () => socket.destroy()); socket.once("close", () => client.destroy());
            client.once("error", () => socket.destroy()); socket.once("error", () => client.destroy());
            client.write(buffer);
            if (head.length) socket.write(head);
            client.pipe(socket); socket.pipe(client); socket.resume(); client.resume();
            this.routed++;
            this.state(SessionTransport.gateway(target.href) ? "gateway conectado pela rota Tor" : "sinalização RTC conectada pela rota Tor");
        } catch { client.destroy(); if (!this.stopped) this.state("conexão de sessão recusada pela rota"); }
    }

    installWebSocket(surface) {
        if (!this.server || this.stopped || this.undoWebSocket) throw new Error("ponte não está pronta");
        const original = surface.WebSocket, owner = this;
        if (typeof original !== "function") throw new Error("WebSocket indisponível");
        const wrapper = new Proxy(original, {
            construct(target, args, newTarget) {
                const url = SessionTransport.gateway(args[0]);
                if (url) {
                    if (owner.stopped) throw new Error("rota desligada");
                    args = [...args];
                    args[0] = `ws://127.0.0.1:${owner.port}/${owner.nonce}?target=${encodeURIComponent(url.href)}`;
                    owner.state("abrindo gateway pela rota Tor");
                }
                return Reflect.construct(target, args, newTarget === wrapper ? target : newTarget);
            }
        });
        surface.WebSocket = wrapper;
        if (surface.WebSocket !== wrapper) throw new Error("não foi possível ligar a ponte");
        this.undoWebSocket = () => { if (surface.WebSocket === wrapper) surface.WebSocket = original; };
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.cancelBoot?.(); this.cancelBoot = null;
        clearTimeout(this.bootTimer);
        this.undoWebSocket?.(); this.undoWebSocket = null;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        this.server?.close(); this.server = null;
        // child.kill targets this owned child only; no taskkill/name-based process selection.
        if (this.child && this.child.exitCode === null) this.child.kill();
        this.child = null;
    }
}

module.exports = {SessionTransport};
