// Unprivileged, authenticated controller for the narrowly scoped Windows worker.
const {routeNativeSnapshot,routeVoiceProof,routeRouterLifecycle}=require('./route-diagnostics.cjs');
const net=require('node:net'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const workerStages=new Set(['idle','extracting','driver','adapter','isolating','address','connecting','connected','stopping','stopped','failed','cleanup-failed']);
const nativeReasons=new Set(['options','certificate','authentication','identity','adapter-missing','adapter-open','adapter-index','driver-io','exit-event','handshake','network-config']);
const nativeMarkers=new Set([...nativeReasons,'driver-missing','driver-version','certificate-verified','peer-authenticated','configuration-received','initialized','fatal-exit','adapter-ready']);
const code=value=>Object.assign(new Error(value),{code:value});
function safeProxyDiagnostic(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  return {stage:['ready','create','bind','interface','resolve','connect','connected'].includes(value.stage)?value.stage:null,
    category:['dns','refused','denied','network-unreachable','host-unreachable','timeout','local-address','internal'].includes(value.category)?value.category:null,
    nativeCode:Number.isInteger(value.nativeCode)&&value.nativeCode>=0&&value.nativeCode<=65535?value.nativeCode:null,
    attempts:Number.isInteger(value.attempts)&&value.attempts>=0&&value.attempts<=3?value.attempts:0,
    addresses:Number.isInteger(value.addresses)&&value.addresses>=0&&value.addresses<=3?value.addresses:0,
    socksReply:Number.isInteger(value.socksReply)&&value.socksReply>=0&&value.socksReply<=8?value.socksReply:null};
}
function safeRouteProof(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  return {inspected:value.inspected===true,tunnelPresent:value.tunnelPresent===true,normalPreserved:value.normalPreserved===true,
    reason:['verified','tunnel-default-missing','tunnel-metric-too-low','normal-default-changed','normal-prefix-conflict','read-failed'].includes(value.reason)?value.reason:null,
    ownRoutes:Number.isInteger(value.ownRoutes)&&value.ownRoutes>=0&&value.ownRoutes<=65535?value.ownRoutes:0,
    ignoredControlRoutes:Number.isInteger(value.ignoredControlRoutes)&&value.ignoredControlRoutes>=0&&value.ignoredControlRoutes<=65535?value.ignoredControlRoutes:0,
    tunnelMetric:Number.isInteger(value.tunnelMetric)&&value.tunnelMetric>=0&&value.tunnelMetric<=4294967295?value.tunnelMetric:null};
}
class VpnBroker {
  constructor({root,onStatus=()=>{},launch,request,delay=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),deadlineAt=Infinity}={}) {
    this.root=root;this.onStatus=onStatus;this.delay=delay;this.now=now;this.deadlineAt=deadlineAt;
    this.token=crypto.randomBytes(32).toString('hex');this.pipe='callshare-vpn-'+this.token.slice(0,24);
    this.launch=launch||(()=>this.launchWorker());this.request=request||((op,payload)=>this.rpc(op,payload));
    this.cancelled=false;this.startSubmitted=false;this.last=null;this.cleanupConfirmed=false;
  }
  async rpc(op,payload) {
    if(!['status','start','stop','resume','pause'].includes(op))throw code('CS_WORKER_INPUT');
    return new Promise((resolve,reject)=>{
      const socket=net.connect('\\\\.\\pipe\\'+this.pipe);let settled=false,body='';
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(code('CS_WORKER_UNAVAILABLE')),3500);
      socket.once('error',()=>finish(code('CS_WORKER_UNAVAILABLE')));
      socket.once('connect',()=>socket.write(JSON.stringify({token:this.token,op,...(payload?{payload}:{})})+'\n'));
      socket.on('data',chunk=>{
        body+=chunk.toString();if(body.length>196608)return finish(code('CS_WORKER_PROTOCOL'));
        const end=body.indexOf('\n');if(end<0)return;
        try{
          const value=JSON.parse(body.slice(0,end));
          if(value.scope!=='discord-process-ipv4')throw Error();
          if(value.workerVersion!=='0.13.4'||!workerStages.has(value.stage))throw Error();
          const safe={stage:value.stage,network:routeNativeSnapshot(value.network),networkBefore:routeNativeSnapshot(value.networkBefore),voiceFilter:routeVoiceProof(value.voiceFilter),
            routingActive:value.routingActive===true,standbyVerified:value.standbyVerified===true,routerLifecycle:routeRouterLifecycle(value.routerLifecycle),
            isolationVerified:value.isolationVerified===true,normalRoutePreserved:value.normalRoutePreserved===true,
            isolationError:Number.isInteger(value.isolationError)&&value.isolationError>=0&&value.isolationError<=4294967295?value.isolationError:null,
            isolationStage:['engine-open','sublayer-add','app-id','interface-luid','filter-add','ready'].includes(value.isolationStage)?value.isolationStage:null,
            routeProof:safeRouteProof(value.routeProof),
            proxyDiagnostic:safeProxyDiagnostic(value.proxyDiagnostic),
            addressState:['not-checked','missing','preferred','tentative','duplicate','deprecated','invalid'].includes(value.addressState)?value.addressState:null,
            processRuleCount:Number.isInteger(value.processRuleCount)&&value.processRuleCount>=0&&value.processRuleCount<=4?value.processRuleCount:0,
            proxyPort:Number.isInteger(value.proxyPort)&&value.proxyPort>=1024&&value.proxyPort<=65535?value.proxyPort:0,
            tcpRelays:Number.isSafeInteger(value.tcpRelays)&&value.tcpRelays>=0?value.tcpRelays:0,udpRelays:Number.isSafeInteger(value.udpRelays)&&value.udpRelays>=0?value.udpRelays:0,routesVerified:value.routesVerified===true,cleanupConfirmed:value.cleanupConfirmed===true,
            failureStage:workerStages.has(value.failureStage)?value.failureStage:null,
            nativeExitCode:Number.isInteger(value.nativeExitCode)&&value.nativeExitCode>=-2147483648&&value.nativeExitCode<=2147483647?value.nativeExitCode:null,
            nativeReason:nativeReasons.has(value.nativeReason)?value.nativeReason:null,
            nativeMarkers:Array.isArray(value.nativeMarkers)?[...new Set(value.nativeMarkers.filter(v=>nativeMarkers.has(v)))].slice(0,20):[],
            country:/^[A-Z]{2}$/.test(value.country||'')?value.country:null,
            failure:/^CS_[A-Z_]{1,50}$/.test(value.failure||'')?value.failure:null};
          finish(null,safe);
        }catch{finish(code('CS_WORKER_PROTOCOL'));}
      });
      socket.once('end',()=>{if(!settled)finish(code('CS_WORKER_UNAVAILABLE'));});
    });
  }
  launchWorker() { return require('./service-client.cjs').launchViaService(this.token); }
  async refreshStatus(){return this.last=await this.request('status');}
  async waitRetired(){
    if(!this.cleanupConfirmed)throw code('CS_VPN_CLEANUP');
    const deadline=this.now()+15000;
    while(this.now()<deadline){
      try{
        const state=await this.request('status');
        if(state.cleanupConfirmed!==true||!['stopped','failed'].includes(state.stage))throw code('CS_VPN_CLEANUP');
      }catch(error){if(error.code==='CS_WORKER_UNAVAILABLE')return;throw error;}
      await this.delay(150);
    }
    throw code('CS_SERVICE_BUSY');
  }
  async setRouting(active){
    if(typeof active!=='boolean')throw code('CS_WORKER_INPUT');
    this.routingRevision=(this.routingRevision||0)+1;
    this.heartbeatFailures=0;this.routingBusy=true;
    try{
    if(this.cancelled)throw code('CS_CANCELLED');
    await this.request(active?'resume':'pause');
    const deadline=this.now()+20000;
    while(this.now()<deadline){
      if(this.cancelled)throw code('CS_CANCELLED');
      const state=this.last=await this.request('status');
      if(state.stage!=='connected'||!state.routesVerified||!state.isolationVerified||!state.normalRoutePreserved)throw code('CS_ISOLATION_ROUTES');
      if(state.routingActive===active&&(active||state.standbyVerified===true))return state;
      await this.delay(100);
    }
    throw code(active?'CS_PROCESS_ROUTER':'CS_PROCESS_CLEANUP');
    }finally{this.routingBusy=false;}
  }
  async start(payload) {
    if(this.cancelled)throw code('CS_CANCELLED');
    if(this.now()>=this.deadlineAt)throw code('CS_PROVIDER_TIMEOUT');
    this.onStatus({phase:'service'});this.launchTask=Promise.resolve().then(()=>{if(this.cancelled)throw code('CS_CANCELLED');return this.launch();});await this.launchTask;
    let available=false;const workerReadyDeadline=Math.min(this.now()+30000,this.deadlineAt);
    while(this.now()<workerReadyDeadline){
      if(this.cancelled)throw code('CS_CANCELLED');
      try{this.last=await this.request('status');available=true;break;}catch{}
      if(this.launchExited)throw code('CS_WORKER_UNAVAILABLE');await this.delay(350);
    }
    if(!available)throw code(this.now()>=this.deadlineAt?'CS_PROVIDER_TIMEOUT':'CS_WORKER_UNAVAILABLE');
    if(this.cancelled)throw code('CS_CANCELLED');
    if(this.now()>=this.deadlineAt)throw code('CS_PROVIDER_TIMEOUT');
    this.startSubmitted=true;this.startTask=this.request('start',payload);await this.startTask;
    const deadline=Math.min(this.now()+220000,this.deadlineAt);
    while(this.now()<deadline){
      if(this.cancelled)throw code('CS_CANCELLED');
      const state=this.last=await this.request('status');this.onStatus({phase:state.stage,country:state.country});
      if(['failed','stopped','cleanup-failed'].includes(state.stage))throw code(state.failure||'CS_VPN_EXIT');
      if(state.stage==='connected'){
        if(!state.routesVerified||!state.isolationVerified||!state.normalRoutePreserved||state.processRuleCount<1||state.proxyPort<1024)throw code('CS_ISOLATION_ROUTES');
        this.heartbeat=setInterval(()=>this.pollHealth(),2000);
        return state;
      }
      await this.delay(400);
    }
    throw code(this.now()>=this.deadlineAt?'CS_PROVIDER_TIMEOUT':'CS_VPN_TIMEOUT');
  }
  async pollHealth(){
    if(this.cancelled||this.heartbeatBusy||this.routingBusy)return;
    this.heartbeatBusy=true;const revision=this.routingRevision;
    try{
      const value=await this.request('status');
      if(this.cancelled||revision!==this.routingRevision)return;
      this.last=value;this.heartbeatFailures=0;
      if(value.stage!=='connected'||!value.routesVerified||!value.isolationVerified||!value.normalRoutePreserved)this.onStatus({phase:'failed',failure:value.failure||'CS_VPN_EXIT'});
    }catch{
      if(this.cancelled||revision!==this.routingRevision)return;
      this.heartbeatFailures=(this.heartbeatFailures||0)+1;
      if(this.heartbeatFailures>=2)this.onStatus({phase:'failed',failure:'CS_WORKER_UNAVAILABLE'});
    }finally{this.heartbeatBusy=false;}
  }
  stop() {
    if(this.stopping)return this.stopping;this.cancelled=true;this.routingRevision=(this.routingRevision||0)+1;clearInterval(this.heartbeat);
    return this.stopping=(async()=>{
      try{await this.launchTask;}catch{}
      try{await this.startTask;}catch{}
      if(!this.startSubmitted){
        try{this.last=await this.request('stop');}catch{}
        if(this.launcher&&!this.launchExited)this.launcher.kill();
        // Without a start payload the privileged worker cannot create a VPN or adapter.
        this.cleanupConfirmed=true;return;
      }
      try{this.last=await this.request('stop');}catch{}
      const deadline=this.now()+85000;
      while(this.now()<deadline){
        if(this.last?.cleanupConfirmed&&['stopped','failed'].includes(this.last.stage)){this.cleanupConfirmed=true;return;}
        if(this.last?.stage==='cleanup-failed')throw code('CS_VPN_CLEANUP');
        await this.delay(400);try{this.last=await this.request('status');}catch{}
      }
      throw code('CS_VPN_CLEANUP');
    })();
  }
}
module.exports={VpnBroker,safeRouteProof,safeProxyDiagnostic};
