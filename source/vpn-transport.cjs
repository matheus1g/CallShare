const {SessionTransport}=require('./session-transport.cjs');
const {RiseupBootstrap}=require('./riseup-bootstrap.cjs');
const {VpnBroker}=require('./vpn-broker.cjs');
const {SESSION_LIMITS}=require('./session-contract.cjs');
const failure=code=>Object.assign(new Error(code),{code});
class VpnTransport extends SessionTransport {
  constructor({root,onStatus=()=>{},scope='rtc',Bootstrap=RiseupBootstrap,Broker=VpnBroker,voiceBypass=null,standby=false,deadlineAt=Infinity,now=()=>Date.now(),selectionMs=SESSION_LIMITS.selectionMs}){
    super({root,onStatus,scope});this.Bootstrap=Bootstrap;this.Broker=Broker;this.controller=new AbortController();
    this.voiceBypass=voiceBypass;this.standby=standby===true;this.backend='leap-openvpn-process';this.cleanupConfirmed=false;this.probeStage='not-started';this.probeCode=null;this.httpStatus=null;
    this.deadlineAt=deadlineAt;this.now=now;this.selectionMs=selectionMs;this.stageTimings=[];
  }
  assertPreparing(){if(this.stopped||this.controller.signal.aborted)throw failure('CS_CANCELLED');if(this.now()>=this.deadlineAt)throw failure('CS_PROVIDER_TIMEOUT');}
  markStage(stage){const at=this.now();if(this.stageName===stage)return;if(this.stageName)this.stageTimings.push({stage:this.stageName,ms:Math.max(0,at-this.stageSince)});this.stageName=stage;this.stageSince=at;}
  timings(){return [...this.stageTimings,...(this.stageName?[{stage:this.stageName,ms:Math.max(0,this.now()-this.stageSince)}]:[])].slice(-20);}
  probeEvidence(){return {stage:this.probeStage,code:this.probeCode,httpStatus:this.httpStatus};}
  healthEvidence(){return {lastCheck:this.healthCheckAt??null,lastSuccess:this.healthSuccessAt??null,failures:this.healthFailures||0,checking:this.healthBusy===true,intervalMs:30000};}
  async probeRouteHealth(){const socket=await this.secure('gateway.discord.gg');socket.destroy();}
  async checkHealth(){
    if(this.stopped||this.healthBusy)return;
    this.healthBusy=true;const generation=this.healthGeneration||0;
    try{await this.probeRouteHealth();if(!this.stopped&&generation===(this.healthGeneration||0)){this.healthSuccessAt=Date.now();this.healthFailures=0;}}
    catch{if(!this.stopped&&generation===(this.healthGeneration||0)){this.healthFailures=Math.min(2,(this.healthFailures||0)+1);if(this.healthFailures>=2){this.onStatus({phase:'failed',failure:'CS_ROUTE_HEALTH'});this.stop().catch(()=>{});}}}
    finally{this.healthCheckAt=Date.now();this.healthBusy=false;}
  }
  setProbeStage(value){if(this.probeStage!=='passed')this.probeStage=value;}
  classifyProxyFailure(code){
    const eligible=['CS_PROXY_SOCKET','CS_PROXY_DENIED','CS_PROBE_REFUSED','CS_PROBE_HOST_UNREACHABLE','CS_PROBE_NETWORK_UNREACHABLE'];
    if(!eligible.includes(code))return code;
    const info=this.broker?.last?.proxyDiagnostic;
    if(!info||info.stage==='ready'||info.stage==='connected')return code;
    if(info.stage==='interface')return 'CS_PROXY_INTERFACE';
    return ({dns:'CS_PROBE_DNS',refused:'CS_PROBE_REFUSED',denied:'CS_PROXY_DENIED','network-unreachable':'CS_PROBE_NETWORK_UNREACHABLE',
      'host-unreachable':'CS_PROBE_HOST_UNREACHABLE',timeout:'CS_PROBE_TIMEOUT','local-address':'CS_PROXY_LOCAL_ADDRESS',internal:'CS_PROXY_SOCKET'})[info.category]||code;
  }
  async choose(gateways){this.assertPreparing();let index=0,finished=false;const pool=gateways.slice(0,SESSION_LIMITS.selectionCandidates),results=[],owned=new Set();
    const abort=()=>{finished=true;for(const socket of owned)socket.destroy();};
    const timer=setTimeout(abort,Math.max(0,Math.min(this.selectionMs,this.deadlineAt-this.now())));
    this.controller.signal.addEventListener('abort',abort,{once:true});
    const run=async()=>{while(index<pool.length&&!finished&&!this.stopped){const gateway=pool[index++],start=this.now();
      if(gateway.tcp!==true){results.push({gateway,ok:false,ms:Infinity});continue;}
      const result=await new Promise(resolve=>{const socket=this.track(this.net.connect({host:gateway.ip,port:gateway.port,family:4}));let done=false;
        owned.add(socket);const finish=ok=>{if(done)return;done=true;owned.delete(socket);socket.destroy();resolve({gateway,ok,ms:this.now()-start});};
        socket.setTimeout(SESSION_LIMITS.selectionSocketMs,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('close',()=>finish(false));});results.push(result);
    }};
    try{await Promise.all(Array.from({length:SESSION_LIMITS.selectionConnections},run));this.assertPreparing();
      const tested=new Set(results.map(r=>r.gateway));for(const gateway of pool)if(!tested.has(gateway))results.push({gateway,ok:false,ms:Infinity});
      return results.sort((a,b)=>Number(b.ok)-Number(a.ok)||a.ms-b.ms).slice(0,4).map(v=>v.gateway);
    }finally{clearTimeout(timer);this.controller.signal.removeEventListener('abort',abort);abort();}
  }
  async start(){let session;
    try{
      this.assertPreparing();this.markStage('provider');this.failureStage='provider';this.onStatus({phase:'provider'});session=await new this.Bootstrap().prepare({signal:this.controller.signal});
      this.sessionInfo={expiresAt:session.expiresAt||null,caExpiresAt:session.caExpiresAt||null};
      this.assertPreparing();
      const profile=session.profile().toString(),block=name=>profile.match(new RegExp('<'+name+'>\\s*([\\s\\S]*?)</'+name+'>'))?.[1];
      this.markStage('selection');this.onStatus({phase:'selection'});const servers=await this.choose(session.gateways);
      this.assertPreparing();
      const payload={ca:block('ca'),cert:block('cert'),key:block('key'),servers};
      if(this.standby)payload.standby=true;
      if(this.voiceBypass){const voice=require('./route-diagnostics.cjs').routeEndpoint(this.voiceBypass.ip,this.voiceBypass.port);if(!voice)throw failure('CS_VOICE_ENDPOINT');payload.voiceBypass=voice;}
      this.markStage('worker');this.failureStage='worker';this.broker=new this.Broker({root:this.root,deadlineAt:this.deadlineAt,onStatus:value=>{
        if(this.stopped)return;
        if(['service','extracting','driver','adapter','isolating','address','connecting','connected'].includes(value.phase))this.markStage(value.phase);
        if(value.phase==='failed'){this.onStatus(value);this.stop().catch(()=>{});}else this.onStatus(value);
      }});
      this.assertPreparing();const state=await this.broker.start(payload);
      if(!state.isolationVerified||!state.normalRoutePreserved)throw failure('CS_ISOLATION_ROUTES');
      this.country=state.country;this.routesVerified=true;
      if(this.stopped)throw failure('CS_CANCELLED');
      this.markStage('probe');this.failureStage='probe';this.onStatus({phase:'probe'});
      try{await this.probeGateway();this.probeStage='passed';}
      catch(e){try{await this.broker.refreshStatus?.();}catch{}
        this.probeCode=this.classifyProxyFailure(e.code||({tls:'CS_PROBE_TLS',http:'CS_PROBE_HTTP'})[this.probeStage]||'CS_PROBE_CONNECT');throw failure(this.probeCode);}
      if(this.stopped)throw failure('CS_CANCELLED');
      this.markStage('bridge');this.failureStage='bridge';await this.listen();
      if(this.stopped){this.server?.close();this.server=null;throw failure('CS_CANCELLED');}
      this.markStage(null);this.healthSuccessAt=Date.now();this.healthFailures=0;
      this.healthTimer=setInterval(()=>this.checkHealth(),30000);this.healthTimer.unref?.();
      this.onStatus({phase:'ready',country:this.country,routesVerified:true});
    }catch(e){await this.stop();throw e;}finally{session?.dispose();}
  }
  async setRouting(active){
    if(this.stopped)throw failure('CS_CANCELLED');
    this.healthGeneration=(this.healthGeneration||0)+1;
    const state=await this.broker.setRouting(active);
    this.standby=!active;
    if(!active)for(const socket of this.sockets)socket.destroy();
    return state;
  }
  async upgrade(req,client,head){if(this.standby){client.destroy();return;}return super.upgrade(req,client,head);}
  async socks(host,port=443){
    if(this.stopped||!this.target(`wss://${host}:${port}/`))throw failure('CS_PROXY_TARGET');
    const proxyPort=this.broker?.last?.proxyPort,token=this.broker?.token;
    if(!Number.isInteger(proxyPort)||proxyPort<1024||!/^[a-f0-9]{64}$/.test(token||''))throw failure('CS_PROXY_NOT_READY');
    this.setProbeStage('local-proxy');const socket=this.track(this.net.connect({host:'127.0.0.1',port:proxyPort}));
    return new Promise((resolve,reject)=>{let phase=0,buffer=Buffer.alloc(0),done=false;
      const finish=e=>{if(done)return;done=true;clearTimeout(timer);socket.removeListener('data',read);socket.removeListener('error',error);socket.removeListener('close',error);
        if(e){socket.destroy();reject(e);}else{socket.pause();this.setProbeStage('tls');resolve(socket);}};
      const error=()=>finish(failure('CS_PROBE_CONNECT'));
      const timer=setTimeout(()=>finish(failure('CS_PROBE_TIMEOUT')),28000);
      const read=chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1024)return finish(failure('CS_PROXY_PROTOCOL'));
        if(phase===0&&buffer.length>=2){if(buffer[0]!==5||buffer[1]!==2)return finish(failure('CS_PROXY_AUTH'));
          buffer=buffer.subarray(2);phase=1;const user=Buffer.from('callshare'),pass=Buffer.from(token);
          socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([pass.length]),pass]));}
        if(phase===1&&buffer.length>=2){if(buffer[0]!==1||buffer[1]!==0)return finish(failure('CS_PROXY_AUTH'));
          buffer=buffer.subarray(2);phase=2;this.setProbeStage('target');const name=Buffer.from(host,'ascii'),end=Buffer.alloc(2);end.writeUInt16BE(port);
          socket.write(Buffer.concat([Buffer.from([5,1,0,3,name.length]),name,end]));}
        if(phase===2&&buffer.length>=5){if(buffer[0]!==5||buffer[2]!==0)return finish(failure('CS_PROXY_PROTOCOL'));
          if(buffer[1]!==0)return finish(failure(({1:'CS_PROXY_SOCKET',2:'CS_PROXY_DENIED',3:'CS_PROBE_NETWORK_UNREACHABLE',4:'CS_PROBE_HOST_UNREACHABLE',5:'CS_PROBE_REFUSED',6:'CS_PROBE_HOST_UNREACHABLE',7:'CS_PROXY_PROTOCOL',8:'CS_PROXY_PROTOCOL'})[buffer[1]]||'CS_PROXY_PROTOCOL'));
          const length=buffer[3]===1?10:buffer[3]===4?22:buffer[3]===3?7+buffer[4]:0;
          if(!length)return finish(failure('CS_PROXY_PROTOCOL'));if(buffer.length<length)return;
          if(buffer.length!==length)return finish(failure('CS_PROXY_PROTOCOL'));finish();}
      };
      socket.once('connect',()=>socket.write(Buffer.from([5,1,2])));socket.once('error',error);socket.once('close',error);socket.on('data',read);
    });
  }
  async secure(host,port=443){const socket=await super.secure(host,port);if(this.probeStage==='passed')return socket;this.setProbeStage('http');
    let first=Buffer.alloc(0);const observe=chunk=>{first=Buffer.concat([first,chunk.subarray(0,64)]).subarray(0,64);const line=first.toString('ascii');
      const match=/^HTTP\/1\.1 ([1-5][0-9]{2})\b/.exec(line);if(match){this.httpStatus=Number(match[1]);socket.removeListener('data',observe);first.fill(0);}else if(first.length>=64){socket.removeListener('data',observe);first.fill(0);}};
    socket.on('data',observe);return socket;
  }
  stop(){if(this.stopping)return this.stopping;clearInterval(this.healthTimer);this.controller.abort();super.stop();
    return this.stopping=(async()=>{await this.broker?.stop();this.cleanupConfirmed=this.broker?this.broker.cleanupConfirmed:true;})();}
}
module.exports={VpnTransport};
