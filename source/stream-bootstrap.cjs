// Short-lived routing around native stream requests. Request keys/closures are
// memory-only; report() projects fixed labels, counters and generated RTC IDs.
class StreamBootstrap {
    constructor({context,prepare,restore,read,event=()=>{},now=()=>Date.now(),settleMs=6000,mediaTimeoutMs=60000,verifyMs=30000}) {
        Object.assign(this,{context,prepare,restore,read,event,now,settleMs,mediaTimeoutMs,verifyMs});
        this.serial=0;this.cycle=null;this.history=[];this.state='idle';this.pending=false;this.failure=null;
    }
    emit(stage,extra={}) {
        const c=this.cycle;if(!c)return;
        const row={at:this.now(),cycle:c.id,stage,...extra};
        this.history.push(row);if(this.history.length>64)this.history.shift();this.event(stage);
    }
    request(request) {
        const ctx=this.context();
        if(!ctx.call || ctx.paused || !ctx.enabled)return request.forward();
        if(this.cycle&&this.cycle.call!==ctx.call)this.cancel();
        // A new user action during verification starts a fresh preparation.
        if(!this.cycle || ['verifying','attention','restoring'].includes(this.state)){this.releaseClosures();this.begin(ctx.call);}
        const c=this.cycle;
        if(c.requests.some(r=>r.key===request.key&&r.kind===request.kind))return;
        if(c.requests.length>=6){this.emit('queue-full');return;}
        c.manual=false;c.requests.push({...request,sent:false,baseline:null,progressSince:null,last:null,proved:false});
        c.stableSince=null;
        this.emit('request',{kind:request.kind});
        if(ctx.ready&&!ctx.restoring){this.state='media';c.readyAt??=this.now();this.flush();}
        else this.ensurePrepared();
    }
    begin(call) {
        this.failure=null;
        this.cycle={id:++this.serial,call,started:this.now(),readyAt:null,requests:[],stableSince:null,verifySince:null};
        this.state='preparing';this.emit('begin');
    }
    arm() {
        const ctx=this.context();if(!ctx.call||!ctx.enabled||ctx.paused)return;
        this.cancel();this.begin(ctx.call);this.cycle.manual=true;this.ensurePrepared();return this.task;
    }
    ensurePrepared() {
        if(this.pending)return;
        const c=this.cycle;if(!c)return;
        this.pending=true;this.state='preparing';
        // Cross an event-loop boundary before inspecting Flux stores or opening
        // the route. Discord may still be dispatching STREAM_START/WATCH.
        this.task=Promise.resolve().then(()=>this.cycle===c?this.prepare():false).then(()=>{
            if(this.cycle!==c)return;
            const ctx=this.context();
            if(ctx.call!==c.call||!ctx.enabled||ctx.paused){this.cancel();return;}
            if(!c.requests.length&&!c.manual){this.emit('cancelled');this.cycle=null;this.state='idle';return;}
            if(!ctx.ready){this.emit('prepare-failed');this.state='attention';this.releaseClosures();return;}
            c.readyAt=this.now();this.state='media';this.emit('route-ready');this.flush();
        }).catch(()=>{if(this.cycle===c){this.emit('prepare-failed');this.state='attention';this.releaseClosures();}})
          .finally(()=>{this.pending=false;if(this.cycle!==c&&this.state==='preparing')this.ensurePrepared();});
    }
    flush() {
        const c=this.cycle;if(!c||this.state!=='media')return;
        for(const r of c.requests){
            if(r.sent)continue;
            if(r.valid&&!r.valid()){r.cancelled=true;continue;}
            r.baseline=this.measure(r);r.sent=true;
            try{r.forward();this.emit('request-sent',{kind:r.kind});}
            catch(error){
                r.cancelled=true;c.requestFailed=true;this.failure='request-failed';
                const errorClass=['Error','TypeError','ReferenceError','RangeError','SyntaxError','DOMException'].includes(error?.name)?error.name:'unknown';
                this.emit('request-failed',{kind:r.kind,errorClass});
            }
            r.forward=null;r.valid=null;
        }
        c.requests=c.requests.filter(r=>!r.cancelled);
    }
    measure(r) {
        try {
            const m=this.read(r.locate());
            if(!m||m.role!==r.kind)return null;
            return {id:/^rtc-\d+$/.test(m.id||'')?m.id:null,state:m.state,
                frames:Number.isSafeInteger(m.frames)&&m.frames>=0?m.frames:null,
                bytes:Number.isSafeInteger(m.bytes)&&m.bytes>=0?m.bytes:null,
                wanted:r.kind==='receive'||m.wanted===true,ping:Number.isFinite(m.ping)&&m.ping>=0?m.ping:null};
        }catch{return null;}
    }
    advanced(m,b) {
        return Boolean(m&&m.state==='RTC_CONNECTED'&&m.wanted&&m.frames!=null&&m.bytes!=null&&
            m.frames>(b?.id===m.id?b.frames??0:0)&&m.bytes>(b?.id===m.id?b.bytes??0:0));
    }
    cancelRequest(key,{send=false}={}) {
        const c=this.cycle;if(!c)return;
        const old=c.requests.length;
        c.requests=c.requests.filter(r=>r.key!==key&&!(send&&r.kind==='send'));
        if(old!==c.requests.length){c.stableSince=null;this.emit('request-cancelled');}
        if(!c.requests.length&&this.state==='verifying'){this.releaseClosures();this.cycle=null;this.state='idle';}
    }
    tick() {
        const c=this.cycle;if(!c)return;
        const ctx=this.context(),now=this.now();
        if(ctx.call!==c.call||!ctx.enabled||ctx.paused){this.cancel();if(ctx.active)this.restore('bootstrap-cancelled');return;}
        if(this.state==='preparing'||this.pending)return;
        if(this.state==='media'){
            if(!ctx.ready){this.emit('route-lost');this.state='attention';this.releaseClosures();return;}
            this.flush();
            for(const r of c.requests){
                const m=this.measure(r);
                if(m&&m.bytes>(r.baseline?.id===m.id?r.baseline.bytes||0:0)&&r.firstTrafficAt==null){r.firstTrafficAt=now;this.emit('first-traffic',{kind:r.kind,elapsedMs:now-c.started});}
                if(this.advanced(m,r.baseline)&&r.firstFrameAt==null){r.firstFrameAt=now;this.emit('first-frame',{kind:r.kind,elapsedMs:now-c.started});}
                if(this.advanced(m,r.baseline)){
                    if(r.progressSince==null)r.progressSince=now;
                    if(now-r.progressSince>=this.settleMs&&this.advanced(m,r.last))r.proved=true;
                }else {r.progressSince=null;r.proved=false;}
                r.last=m;
            }
            if(c.requests.length&&c.requests.every(r=>r.proved))return this.finish('media-ready');
            if(!c.requests.length&&!c.manual)return this.finish(c.requestFailed?'request-error':'cancelled');
            if(c.readyAt!=null&&now-c.readyAt>=this.mediaTimeoutMs)return this.finish('media-timeout');
        }
        if(this.state==='verifying'){
            for(const r of c.requests){
                const m=this.measure(r);
                if(this.advanced(m,r.after))r.continued=true;
                r.last=m;
            }
            if(c.requests.length&&c.requests.every(r=>r.continued)&&now-c.verifySince>=3000){
                this.emit('normal-media-confirmed',{streams:this.evidence()});this.releaseClosures();this.cycle=null;this.state=c.requestFailed?'attention':'idle';
            }else if(now-c.verifySince>=this.verifyMs){this.emit('normal-media-unconfirmed',{streams:this.evidence()});this.state='attention';this.releaseClosures();}
        }
    }
    finish(reason) {
        const c=this.cycle;if(!c||this.state==='restoring')return;
        this.emit(reason,{streams:this.evidence()});this.state='restoring';
        this.task=Promise.resolve().then(()=>this.cycle===c?this.restore('bootstrap-complete'):false).then(ok=>{
            if(this.cycle!==c)return;
            const ctx=this.context();
            if(ok===false||ctx.active||ctx.restoring){this.emit('restore-failed');this.state='attention';this.releaseClosures();return;}
            if(!c.requests.length){this.cycle=null;this.state=c.requestFailed?'attention':'idle';return;}
            for(const r of c.requests){r.after=this.measure(r);r.continued=false;}
            c.verifySince=this.now();this.state='verifying';this.emit('normal-route',{streams:this.evidence()});
        }).catch(()=>{if(this.cycle===c){this.emit('restore-failed');this.state='attention';this.releaseClosures();}});
    }
    evidence() {
        return (this.cycle?.requests||[]).map(r=>({kind:r.kind,id:r.last?.id??null,frames:r.last?.frames??null,
            bytes:r.last?.bytes??null,ping:r.last?.ping??null,mediaProved:r.proved===true,continued:r.continued===true}));
    }
    releaseClosures(){for(const r of this.cycle?.requests||[]){r.forward=null;r.valid=null;r.locate=()=>null;r.key=null;}}
    cancel(){if(this.cycle)this.emit('cancelled');this.releaseClosures();this.cycle=null;this.state='idle';}
    report(){return {strategy:'on-demand',state:this.state,failure:this.failure,preparing:this.pending,settleMs:this.settleMs,mediaTimeoutMs:this.mediaTimeoutMs,verifyMs:this.verifyMs,
        queued:this.cycle?.requests.filter(r=>!r.sent).length||0,streams:this.evidence(),history:this.history.map(r=>({...r}))};}
}
if(typeof module!=='undefined')module.exports={StreamBootstrap};
