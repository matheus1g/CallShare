// Native companion: launched only by the plugin's explicit Prepare action.
const {routeEndpoint,routeProvider}=require('./route-diagnostics.cjs');
const {providerCertificateInfo}=require('./provider-monitor.cjs');
const {SESSION_LIMITS}=require('./session-contract.cjs');
async function runCallShareHelper(root, {Transport = require('./provider-transport.cjs').ProviderTransport, exit = () => process.exit(0), leaseMs = 30000, watchdogMs = 5000, Provider = require('./riseup-bootstrap.cjs').RiseupBootstrap} = {}) {
    const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
    const http = require('node:http'), crypto = require('node:crypto');
    const version = '0.16.0';
    const controlDir = path.join(root, 'control');
    const endpointFile = path.join(controlDir, 'endpoint.json');
    const instance = crypto.randomBytes(32).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const pipeName = '\\\\.\\pipe\\callshare-' + crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32);
    const lock = net.createServer(socket => socket.end());
    try {
        await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(pipeName,resolve);});
    } catch (error) {
        if(error.code === 'EADDRINUSE') return;
        throw error;
    }
    let phase='idle', progress=0, failure=null, stopping=false, closing=false, lease=Date.now(), starting=false,stopPromise;
    let country=null,routesVerified=false,cleanupConfirmed=false,serviceInfo=null;
    const clients=new Set();
    let route, control, watchdog,publicCheck=null,switchTask=Promise.resolve();
    const endpoint=()=>({protocol:1,version,instance,controlPort:control.address().port,token});
    const status=()=>({protocol:1,version,instance,phase,progress,failure,scope:'rtc',backend:'leap-openvpn-process',
        environment:{windows:require('node:os').release(),node:process.versions.node,arch:process.arch},
        health:route?.healthEvidence?.()||null,provider:routeProvider(route?.providerEvidence?.()),
        country,routesVerified,cleanupConfirmed,isolationVerified:route?.broker?.last?.isolationVerified===true,normalRoutePreserved:route?.broker?.last?.normalRoutePreserved===true,processRuleCount:route?.broker?.last?.processRuleCount||0,tcpRelays:route?.broker?.last?.tcpRelays||0,udpRelays:route?.broker?.last?.udpRelays||0,networkScope:'discord-process-ipv4',
        routingActive:route?.broker?.last?.routingActive===true,standbyVerified:route?.broker?.last?.standbyVerified===true,routerLifecycle:route?.broker?.last?.routerLifecycle||null,
        isolationError:route?.broker?.last?.isolationError??null,isolationStage:route?.broker?.last?.isolationStage||null,routeProof:route?.broker?.last?.routeProof||null,probe:route?.probeEvidence?.()||null,serviceDiagnostic:serviceInfo,
        network:route?.broker?.last?.network||null,networkBefore:route?.broker?.last?.networkBefore||null,voiceFilter:route?.broker?.last?.voiceFilter||null,
        addressState:route?.broker?.last?.addressState||null,proxyDiagnostic:route?.broker?.last?.proxyDiagnostic||null,
        workerStage:route?.broker?.last?.failureStage||route?.broker?.last?.stage||null,
        nativeExitCode:route?.broker?.last?.nativeExitCode??null,nativeReason:route?.broker?.last?.nativeReason??null,
        nativeMarkers:route?.broker?.last?.nativeMarkers||[],
        bridge:phase==='ready'?{port:route.port,nonce:route.nonce}:null});
    async function disconnect(){
        if(stopPromise)return stopPromise;
        stopping=true;phase='stopping';clearInterval(watchdog);
        return stopPromise=(async()=>{
            try{await route?.stop();cleanupConfirmed=route?route.cleanupConfirmed===true:true;
                if(!cleanupConfirmed)throw Error();routesVerified=false;phase='stopped';}
            catch{phase='cleanup-failed';failure='CS_VPN_CLEANUP';throw Object.assign(new Error(failure),{code:failure});}
        })();
    }
    async function stop(){
        if(closing)return;closing=true;
        try{await disconnect();}catch{}
        for(const socket of clients)socket.destroy();
        control?.close();lock.close();
        try{
            const current=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
            if(current.instance===instance)fs.unlinkSync(endpointFile);
        }catch{}
        // The tunnel worker has its own lease. The installed broker remains idle without a tunnel.
        setTimeout(exit,100).unref();
    }
    function onStatus(value){
        if(stopping||!value||typeof value!=='object')return;
        if(['provider','selection','service','extracting','driver','adapter','isolating','address','connecting','connected','probe','ready','failed'].includes(value.phase))phase=value.phase;
        if(/^[A-Z]{2}$/.test(value.country||''))country=value.country;
        if(value.routesVerified===true)routesVerified=true;
        if(value.phase==='failed')failure=/^CS_[A-Z_]{1,50}$/.test(value.failure||'')?value.failure:'CS_HELPER_INTERNAL';
    }
    async function start(voiceBypass=null,standby=false,deadlineAt=Date.now()+SESSION_LIMITS.prepareMs){
        if(starting||phase==='ready'||stopping)return;
        if(Date.now()>=deadlineAt){phase='failed';failure='CS_PREPARE_TIMEOUT';cleanupConfirmed=true;return;}
        starting=true;phase='starting';failure=null;
        try{route=new Transport({root,onStatus,scope:'rtc',voiceBypass,standby,deadlineAt});await route.start();if(!stopping){phase='ready';routesVerified=route.routesVerified===true;}}
        catch(error){
            const diagnostic=error.serviceDiagnostic;
            if(diagnostic)serviceInfo={stage:['starting','listening','responded','stopped','start-failed','pipe-failed','request-failed'].includes(diagnostic.stage)?diagnostic.stage:null,
                failure:['CS_SERVICE_BUSY','CS_SERVICE_AUTH','CS_SERVICE_INPUT','CS_SERVICE_LAUNCH','CS_SERVICE_START','CS_SERVICE_PIPE'].includes(diagnostic.failure)?diagnostic.failure:null,
                nativeCode:Number.isInteger(diagnostic.nativeCode)&&diagnostic.nativeCode>=0&&diagnostic.nativeCode<=4294967295?diagnostic.nativeCode:null};
            if(!stopping){
                const stage=route?.failureStage||'unknown';
                phase='failed';failure=/^CS_[A-Z_]{1,50}$/.test(error.code||'')?error.code:
                    ({provider:'CS_PROVIDER_NETWORK',worker:'CS_WORKER_UNAVAILABLE',probe:'CS_GATEWAY_PROBE',bridge:'CS_BRIDGE'})[stage]||'CS_HELPER_INTERNAL';
                cleanupConfirmed=route?.cleanupConfirmed===true;
            }
        }finally{starting=false;}
    }
    try{
        control=http.createServer({maxHeaderSize:4096},(req,res)=>{
            const respond=(code,payload)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});res.end(JSON.stringify(payload));};
            if(req.headers.host!==`127.0.0.1:${control.address().port}`||
                (req.headers.origin&&req.headers.origin!=='https://discord.com')||
                req.headers.authorization!==`Bearer ${token}`||Number(req.headers['content-length']||0)>0||req.headers['transfer-encoding']){
                respond(403,{error:'refused'});return;
            }
            if(req.url==='/status'&&req.method==='GET'){
                lease=Date.now();
                const value=status();
                for(const key of ['network','networkBefore']){
                    const at=value[key]?.at;
                    if(Number.isSafeInteger(at)&&at>0&&req.headers['x-callshare-'+key.toLowerCase()]===String(at)){
                        delete value[key];
                        value[key+'UnchangedAt']=at;
                    }
                }
                respond(200,value);return;
            }
            if(req.url==='/provider-check'&&req.method==='POST'){
                lease=Date.now();req.socket.setTimeout(50000);
                if(!publicCheck)publicCheck=Promise.resolve().then(()=>new Provider().checkCertificate()).finally(()=>{publicCheck=null;lease=Date.now();});
                publicCheck.then(value=>respond(200,{protocol:1,version,instance,providerCertificate:providerCertificateInfo(value)}))
                    .catch(()=>respond(200,{protocol:1,version,instance,providerCertificate:{provider:'riseup',checkedAt:Date.now(),status:'unavailable',validated:false}}));return;
            }
            if(['/resume','/pause'].includes(req.url)&&req.method==='POST'){
                if(phase!=='ready'||stopping||!route?.setRouting){respond(409,{error:'not-ready'});return;}
                lease=Date.now();req.socket.setTimeout(30000);
                const active=req.url==='/resume';
                switchTask=switchTask.catch(()=>{}).then(()=>route.setRouting(active));
                switchTask.then(()=>respond(200,status())).catch(()=>respond(503,status()));return;
            }
            const voiceMatch=/^\/(start-voice|warm-voice)\/([0-9.]{7,15})\/(\d{1,5})$/.exec(req.url);
            const requestedDeadline=req.headers['x-callshare-deadline'];
            if((voiceMatch||req.url==='/start')&&requestedDeadline!==undefined&&!/^\d{10,16}$/.test(String(requestedDeadline))){respond(400,{error:'invalid-deadline'});return;}
            const deadlineAt=Math.min(requestedDeadline===undefined?Infinity:Number(requestedDeadline),Date.now()+SESSION_LIMITS.prepareMs);
            if(voiceMatch && req.method==='POST'){const voice=routeEndpoint(voiceMatch[2],Number(voiceMatch[3]));
                if(!voice){respond(400,{error:'invalid-voice-endpoint'});return;}lease=Date.now();start(voice,voiceMatch[1]==='warm-voice',deadlineAt);respond(202,status());return;}
            if(req.url==='/start'&&req.method==='POST'){lease=Date.now();start(null,false,deadlineAt);respond(202,status());return;}
            if(req.url==='/stop'&&req.method==='POST'){
                req.socket.setTimeout(95000);
                disconnect().then(()=>{respond(200,status());setTimeout(stop,200).unref();})
                    .catch(()=>{respond(503,status());setTimeout(stop,200).unref();});return;
            }
            respond(404,{error:'unknown'});
        });
        control.maxConnections=12;
        control.on('connection',socket=>{clients.add(socket);socket.on('close',()=>clients.delete(socket));socket.on('error',()=>{});socket.setTimeout(5000,()=>socket.destroy());});
        control.on('clientError',(_error,socket)=>socket.destroy());
        await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(0,'127.0.0.1',resolve);});
        control.on('error',()=>{stop();});
        fs.mkdirSync(controlDir,{recursive:true});
        const temp=endpointFile+'.'+instance+'.tmp';fs.writeFileSync(temp,JSON.stringify(endpoint()),{mode:0o600});fs.renameSync(temp,endpointFile);
        // Plugin heartbeat owns the lifetime; loss of contact initiates VPN cleanup.
        watchdog=setInterval(()=>{if(!publicCheck&&Date.now()-lease>leaseMs)stop();},watchdogMs);
        process.once('SIGTERM',stop);process.once('SIGINT',stop);
        return {stop,endpoint:endpoint(),status};
    }catch(error){stop();throw error;}
}

module.exports={runCallShareHelper};
