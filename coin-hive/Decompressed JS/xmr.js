class XMRJobThread {
    constructor() {
        this.worker = new Worker("cryptonight-worker.js?v4");
        this.worker.onmessage = this.onReady.bind(this);
        this.currentJob = null;
        this.jobCallback = function() {};
        this._isReady = false;
        this.hashesPerSecond = 0;
        this.running = false
    }
    onReady(msg) {
        if (msg.data !== "ready" || this._isReady) {
            throw 'Expecting first message to be "ready", got ' + msg
        }
        this._isReady = true;
        this.worker.onmessage = this.onReceiveMsg.bind(this);
        if (this.currentJob) {
            this.running = true;
            this.worker.postMessage(this.currentJob)
        }
    }
    onReceiveMsg(msg) {
        if (msg.data.hash) {
            this.jobCallback(msg.data.job_id, msg.data.nonce, msg.data.hash)
        }
        this.hashesPerSecond = msg.data.hashesPerSecond;
        if (this.running) {
            this.worker.postMessage(this.currentJob)
        }
    }
    setJob(job, callback) {
        this.currentJob = job;
        this.jobCallback = callback;
        if (this._isReady && !this.running) {
            this.running = true;
            this.worker.postMessage(this.currentJob)
        }
    }
    stop() {
        this.running = false
    }
}
class XMR {
    constructor(user, token, proxyUrl, numThreads) {
        this.user = user;
        this.token = token;
        this.proxyUrl = proxyUrl;
        this.threads = [];
        this.shares = 0;
        this.currentJob = null;
        this.onUpdatePoolStats = function(poolStats) {};
        this.onTargetMetBound = this.onTargetMet.bind(this);
        this.logCallback = function() {};
        this.setNumThreads(numThreads || 0);
        this.connect()
    }
    connect() {
        if (this.socket) {
            return
        }
        this.logCallback({
            notice: "connecting"
        });
        this.socket = new WebSocket(this.proxyUrl);
        this.socket.onmessage = this.onMessage.bind(this);
        this.socket.onerror = this.onClose.bind(this);
        this.socket.onclose = this.onClose.bind(this);
        this.socket.onopen = function() {
            this.send("get_shares", {
                user: this.user
            });
            if (this.currentJob) {
                this.setJob(this.currentJob)
            }
        }.bind(this)
    }
    setNumThreads(num) {
        var num = Math.max(0, num);
        if (num > this.threads.length) {
            for (var i = 0; num > this.threads.length; i++) {
                var thread = new XMRJobThread;
                if (this.currentJob) {
                    thread.setJob(this.currentJob, this.onTargetMetBound)
                }
                this.threads.push(thread)
            }
        } else if (num < this.threads.length) {
            while (num < this.threads.length) {
                var thread = this.threads.pop();
                thread.stop()
            }
        }
    }
    onMessage(ev) {
        var msg = JSON.parse(ev.data);
        this.logCallback(msg);
        if (msg.type === "job") {
            this.setJob(msg.params)
        } else if (msg.type === "job_accepted") {
            this.shares = msg.params.shares
        } else if (msg.type === "redeem_success") {
            this.shares = 0
        } else if (msg.type === "redeem_failed") {
            alert("Fehler beim einlösen. Unbekannter User?")
        } else if (msg.type === "shares") {
            this.shares = msg.params.shares
        } else if (msg.type === "pool_stats") {
            this.onUpdatePoolStats(msg.params)
        }
    }
    onClose(ev) {
        for (var i = 0; i < this.threads.length; i++) {
            this.threads[i].stop()
        }
        this.socket = null;
        this.logCallback({
            error: "connection lost"
        });
        setTimeout(this.connect.bind(this), 10 * 1e3)
    }
    setJob(job) {
        this.currentJob = job;
        for (var i = 0; i < this.threads.length; i++) {
            this.threads[i].setJob(job, this.onTargetMetBound)
        }
    }
    onTargetMet(job_id, nonce, result) {
        if (job_id === this.currentJob.job_id) {
            this.send("submit", {
                user: this.user,
                job_id: job_id,
                nonce: nonce,
                result: result
            })
        }
    }
    redeem() {
        this.send("redeem", {
            user: this.user,
            token: this.token
        })
    }
    send(type, params) {
        if (!this.socket) {
            return
        }
        var msg = {
            type: type,
            params: params || {}
        };
        this.logCallback(msg);
        this.socket.send(JSON.stringify(msg))
    }
}
class XMRUI {
    constructor(xmr, elements) {
        this.elements = elements;
        this.xmr = xmr;
        this.xmr.logCallback = this.onLogMessage.bind(this);
        this.xmr.onUpdatePoolStats = this.updatePoolStats.bind(this);
        this.minRedeemSeconds = 24 * 60 * 60;
        this.sharesToSeconds = .05;
        this.statsCtx = this.elements.canvas.getContext("2d");
        var ratio = window.devicePixelRatio || 1;
        if (ratio !== 1) {
            this.elements.canvas.width = 300 * ratio;
            this.elements.canvas.height = 80 * ratio;
            this.statsCtx.scale(ratio, ratio)
        }
        this.stats = [];
        for (var i = 0, x = 0; x < 300; i++, x += 5) {
            this.stats.push({
                hashes: 0,
                shares: 0,
                accepted: 0
            })
        }
        this.elements.threadAdd.addEventListener("click", this.threadAdd.bind(this));
        this.elements.threadRemove.addEventListener("click", this.threadRemove.bind(this));
        this.elements.redeem.addEventListener("click", this.redeem.bind(this));
        this.elements.redeem.textContent = this.xmr.user ? "Einlösen (" + this.xmr.user + ")" : "Nicht angemeldet!";
        setInterval(this.update.bind(this), 1e3)
    }
    updatePoolStats(poolStats) {
        this.elements.poolHashesPerSecond.textContent = Math.round(poolStats.hashes);
        var rows = [];
        for (var i = 0; i < poolStats.toplist.length; i++) {
            var t = poolStats.toplist[i];
            var name = t.name.replace(/[\W]/g, "");
            rows.push("<tr>" + '<td class="rank">' + (i + 1) + ".</td>" + '<td><a target="_blank" href="http://pr0gramm.com/user/' + name + '">' + name + "</td>" + '<td class="num">' + Math.round(t.hashes) + "</td>" + "</tr>")
        }
        this.elements.toplist.innerHTML = rows.join("\n")
    }
    threadAdd(ev) {
        this.xmr.setNumThreads(this.xmr.threads.length + 1);
        this.elements.threads.textContent = this.xmr.threads.length;
        ev.preventDefault();
        return false
    }
    threadRemove(ev) {
        this.xmr.setNumThreads(this.xmr.threads.length - 1);
        this.elements.threads.textContent = this.xmr.threads.length;
        ev.preventDefault();
        return false
    }
    update() {
        var current = this.stats.shift();
        var last = this.stats[this.stats.length - 1];
        current.hashes = 0;
        current.shares = this.xmr.shares;
        current.accepted = current.shares > last.shares;
        for (var i = 0; i < this.xmr.threads.length; i++) {
            current.hashes += this.xmr.threads[i].hashesPerSecond
        }
        current.hashes = Math.round(last.hashes * .5 + current.hashes * .5);
        this.stats.push(current);
        var seconds = current.shares * this.sharesToSeconds | 0;
        this.elements.hashesPerSecond.textContent = current.hashes;
        this.elements.threads.textContent = this.xmr.threads.length;
        this.elements.acceptedShares.textContent = current.shares;
        this.elements.pr0miumSeconds.textContent = seconds;
        var redeemIsDisabled = this.elements.redeem.classList.contains("disabled");
        if (seconds > this.minRedeemSeconds && redeemIsDisabled) {
            this.elements.redeem.classList.remove("disabled")
        } else if (seconds < this.minRedeemSeconds && !redeemIsDisabled) {
            this.elements.redeem.classList.add("disabled")
        }
        this.drawStats()
    }
    redeem() {
        if (this.elements.redeem.classList.contains("disabled")) {
            return
        }
        xmr.redeem()
    }
    drawStats() {
        var w = 320;
        var h = 80;
        var ctx = this.statsCtx;
        var vmax = 0;
        for (var i = 0; i < this.stats.length; i++) {
            var v = this.stats[i].hashes;
            if (v > vmax) {
                vmax = v
            }
        }
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#555";
        for (var i = 0; i < this.stats.length; i++) {
            var s = this.stats[i];
            var vh = s.hashes / vmax * h | 0;
            if (s.accepted) {
                ctx.fillStyle = "#75c0c7";
                ctx.fillRect(i * 5, h - vh, 4, vh);
                ctx.fillStyle = "#555"
            } else {
                ctx.fillRect(i * 5, h - vh, 4, vh)
            }
        }
    }
    onLogMessage(msg) {}
}
