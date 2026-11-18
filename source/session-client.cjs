if(typeof require==='function' && typeof BdApi==='undefined'){var {routeNativeSnapshot,routeEndpoint,routeProvider,routeEnvironment,routeVoiceProof,routeHealth,routeRouterLifecycle}=require('./route-diagnostics.cjs');var {providerCertificateInfo}=require('./provider-monitor.cjs');var {SESSION_LIMITS,providerLabel}=require('./session-contract.cjs');}
// Renderer client uses only BetterDiscord's supported path/fs/crypto/electron APIs.
class SessionClient {
    constructor({root,onStatus=()=>{},fetch,fs,path,crypto,launch,scope='rtc',onEvidence=()=>{}}) {
        this.root=root;this.onStatus=onStatus;this.fetch=fetch;this.fs=fs;this.path=path;this.crypto=crypto;this.launch=launch;
        this.status='desligada';this.stopped=false;this.routed=0;this.endpoint=null;this.heartbeat=null;
        this.routingRevision=0;this.verifying=false;
        this.scope=scope==='rtc'?'rtc':'gateway';this.onEvidence=onEvidence;
        this.stats={gateway:this.emptyStats(),rtc:this.emptyStats()};
        this.rtcPorts=new Set();this.unroutedRtcPorts=new Set();
    }

    emptyStats(){return {attempts:0,opened:0,active:0,failed:0,closed:0,lastConnectMs:null,lastCloseCode:null};}
    nativeEvidence(value){
        const reasons=['options','certificate','authentication','identity','adapter-missing','adapter-open','adapter-index','driver-io','exit-event','handshake','network-config'];
        const markers=[...reasons,'driver-missing','driver-version','certificate-verified','peer-authenticated','configuration-received','initialized','fatal-exit','adapter-ready'];
        const service=value?.serviceDiagnostic||{stage:value?.serviceStage,failure:value?.serviceFailure,nativeCode:value?.serviceNativeCode};
        return {serviceStage:['starting','listening','responded','stopped','start-failed','pipe-failed','request-failed'].includes(service.stage)?service.stage:null,
            serviceFailure:['CS_SERVICE_BUSY','CS_SERVICE_AUTH','CS_SERVICE_INPUT','CS_SERVICE_LAUNCH','CS_SERVICE_START','CS_SERVICE_PIPE'].includes(service.failure)?service.failure:null,
            serviceNativeCode:Number.isInteger(service.nativeCode)&&service.nativeCode>=0&&service.nativeCode<=4294967295?service.nativeCode:null,
            nativeExitCode:Number.isInteger(value?.nativeExitCode)&&value.nativeExitCode>=-2147483648&&value.nativeExitCode<=2147483647?value.nativeExitCode:null,
            nativeReason:reasons.includes(value?.nativeReason)?value.nativeReason:null,
            nativeMarkers:Array.isArray(value?.nativeMarkers)?[...new Set(value.nativeMarkers.filter(v=>markers.includes(v)))].slice(0,20):[]};
    }
    routeProofEvidence(value){
        if(!value||typeof value!=='object'||Array.isArray(value))return null;
        return {inspected:value.inspected===true,tunnelPresent:value.tunnelPresent===true,normalPreserved:value.normalPreserved===true,
            reason:['verified','tunnel-default-missing','tunnel-metric-too-low','normal-default-changed','normal-prefix-conflict','read-failed'].includes(value.reason)?value.reason:null,
            ownRoutes:Number.isInteger(value.ownRoutes)&&value.ownRoutes>=0&&value.ownRoutes<=65535?value.ownRoutes:0,
            ignoredControlRoutes:Number.isInteger(value.ignoredControlRoutes)&&value.ignoredControlRoutes>=0&&value.ignoredControlRoutes<=65535?value.ignoredControlRoutes:0,
            tunnelMetric:Number.isInteger(value.tunnelMetric)&&value.tunnelMetric>=0&&value.tunnelMetric<=4294967295?value.tunnelMetric:null};
    }
    proxyEvidence(value){
        if(!value||typeof value!=='object'||Array.isArray(value))return null;
        return {stage:['ready','create','bind','interface','resolve','connect','connected'].includes(value.stage)?value.stage:null,
            category:['dns','refused','denied','network-unreachable','host-unreachable','timeout','local-address','internal'].includes(value.category)?value.category:null,
            nativeCode:Number.isInteger(value.nativeCode)&&value.nativeCode>=0&&value.nativeCode<=65535?value.nativeCode:null,
            attempts:Number.isInteger(value.attempts)&&value.attempts>=0&&value.attempts<=3?value.attempts:0,
            addresses:Number.isInteger(value.addresses)&&value.addresses>=0&&value.addresses<=3?value.addresses:0,
            socksReply:Number.isInteger(value.socksReply)&&value.socksReply>=0&&value.socksReply<=8?value.socksReply:null};
    }
    isolationEvidence(value){return {provider:routeProvider(value?.provider),routerLifecycle:routeRouterLifecycle(value?.routerLifecycle),routingActive:value?.routingActive===true,standbyVerified:value?.standbyVerified===true,health:routeHealth(value?.health),voiceFilter:routeVoiceProof(value?.voiceFilter),environment:routeEnvironment(value?.environment),network:routeNativeSnapshot(value?.network),networkBefore:routeNativeSnapshot(value?.networkBefore),networkAfter:routeNativeSnapshot(value?.networkAfter),isolationVerified:value?.isolationVerified===true,normalRoutePreserved:value?.normalRoutePreserved===true,routeProof:this.routeProofEvidence(value?.routeProof),
        addressState:['not-checked','missing','preferred','tentative','duplicate','deprecated','invalid'].includes(value?.addressState)?value.addressState:null,
        proxyDiagnostic:this.proxyEvidence(value?.proxyDiagnostic),
        isolationError:Number.isInteger(value?.isolationError)&&value.isolationError>=0&&value.isolationError<=4294967295?value.isolationError:null,
        isolationStage:['engine-open','sublayer-add','app-id','interface-luid','filter-add','ready'].includes(value?.isolationStage)?value.isolationStage:null,
        processRuleCount:Number.isInteger(value?.processRuleCount)&&value.processRuleCount>=0&&value.processRuleCount<=4?value.processRuleCount:0,
        tcpRelays:Number.isSafeInteger(value?.tcpRelays)&&value.tcpRelays>=0?value.tcpRelays:0,udpRelays:Number.isSafeInteger(value?.udpRelays)&&value.udpRelays>=0?value.udpRelays:0,
        probe:{stage:['not-started','local-proxy','target','tls','http','passed'].includes(value?.probe?.stage)?value.probe.stage:null,
            code:['CS_PROBE_CONNECT','CS_PROBE_TIMEOUT','CS_PROBE_DNS','CS_PROBE_REFUSED','CS_PROXY_BIND','CS_PROXY_SOCKET','CS_PROXY_DENIED','CS_PROXY_INTERFACE','CS_PROXY_LOCAL_ADDRESS','CS_PROBE_NETWORK_UNREACHABLE','CS_PROBE_HOST_UNREACHABLE','CS_VPN_ADDRESS_NOT_READY','CS_PROBE_TARGET','CS_PROBE_TLS','CS_PROBE_HTTP','CS_PROXY_TARGET','CS_PROXY_NOT_READY','CS_PROXY_PROTOCOL','CS_PROXY_AUTH'].includes(value?.probe?.code)?value.probe.code:null,httpStatus:Number.isInteger(value?.probe?.httpStatus)&&value.probe.httpStatus>=100&&value.probe.httpStatus<=599?value.probe.httpStatus:null}};}
    evidence(){return {scope:this.scope,terminalFailure:SessionClient.terminalCode(this.terminalFailure),lastVerifiedAt:this.lastVerifiedAt??null,backend:'leap-openvpn-process',country:this.lastStatus?.country||null,
        ...this.nativeEvidence(this.lastStatus),...this.isolationEvidence(this.lastStatus),
        workerStage:this.lastStatus?.workerStage||null,
        routesVerified:this.lastStatus?.routesVerified===true,cleanupConfirmed:this.cleanupConfirmed===true,
        gateway:{...this.stats.gateway},rtc:{...this.stats.rtc},rtcPorts:[...this.rtcPorts],unroutedRtcPorts:[...this.unroutedRtcPorts]};}

    state(value){if(this.status===value)return;this.status=value;this.onStatus(value);}
    error(code){const error=new Error(code);error.code=code;return error;}
    static terminalCode(value){return ['CS_ROUTE_HEALTH','CS_VPN_TLS','CS_VPN_AUTH','CS_VPN_TIMEOUT','CS_VPN_EXIT','CS_PROVIDER_IDENTITY','CS_ISOLATION_ROUTES','CS_VOICE_FILTER','CS_WORKER_UNAVAILABLE','CS_HELPER_CONTROL','CS_AUTO_ROUTE_ENDED'].includes(value)?value:null;}
    delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
    static gateway(value){
        try{const u=new URL(value);return u.protocol==='wss:'&&/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(u.hostname)&&
            (!u.port||u.port==='443')&&!u.username&&!u.password&&u.pathname==='/'&&!u.hash?u:null;}catch{return null;}
    }
    static rtcHost(value){
        // RTC ports come from Discord's endpoint, not a fixed client-side list.
        // URL validates the upper bound; port zero is not a destination service.
        try{const u=new URL(value);return u.protocol==='wss:'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.discord\.media$/.test(u.hostname)&&
            (!u.port||Number(u.port)>0)&&!u.username&&!u.password&&u.pathname==='/'&&!u.hash?u:null;}catch{return null;}
    }
    static rtc(value){return SessionClient.rtcHost(value);}
    readEndpoint(){
        try{
            const file=this.path.join(this.root,'control','endpoint.json');
            if(this.fs.statSync(file).size>4096)return null;
            const value=JSON.parse(this.fs.readFileSync(file,'utf8'));
            if(value.protocol!==1||value.version!=='0.15.2'||!Number.isInteger(value.controlPort)||value.controlPort<1024||value.controlPort>65535||
                !/^[a-f0-9]{64}$/.test(value.instance)||!/^[a-f0-9]{64}$/.test(value.token))return null;
            return value;
        }catch{return null;}
    }
    async command(endpoint,path,method='GET'){
        const startHeaders=method==='POST'&&/^\/(?:start|start-voice|warm-voice)(?:\/|$)/.test(path)&&Number.isSafeInteger(this.prepareDeadline)?{'X-CallShare-Deadline':String(this.prepareDeadline)}:{};
        const response=await this.fetch(`http://127.0.0.1:${endpoint.controlPort}${path}`,{
            method,headers:{Authorization:`Bearer ${endpoint.token}`,...startHeaders},timeout:path==='/stop'?95000:path==='/provider-check'?50000:['/pause','/resume'].includes(path)?30000:2500,redirect:'error'});
        if(!response||response.status<200||response.status>=300)throw this.error('CS_HELPER_CONTROL');
        const result=await response.json();
        if(result.protocol!==1||result.version!=='0.15.2'||result.instance!==endpoint.instance)throw this.error('CS_HELPER_PROTOCOL');
        return result;
    }
    async available(){
        const endpoint=this.readEndpoint();if(!endpoint)return false;
        try{const status=await this.command(endpoint,'/status');
            if(['stopping','stopped','failed','cleanup-failed'].includes(status.phase)){this.retiringEndpoint=endpoint;return false;}
            this.endpoint=endpoint;return true;}catch{return false;}
    }
    async verifyActiveRoute(){
        if(this.stopped||this.switching||this.verifying)return false;
        this.verifying=true;const revision=this.routingRevision;
        try{
            const status=await this.command(this.endpoint,'/status');
            if(this.stopped||this.switching||revision!==this.routingRevision)return false;
            this.lastStatus={...this.nativeEvidence(status),...this.isolationEvidence(status),country:/^[A-Z]{2}$/.test(status.country||'')?status.country:null,routesVerified:status.routesVerified===true,
                workerStage:['idle','extracting','driver','adapter','isolating','address','connecting','connected','stopping','stopped','failed','cleanup-failed'].includes(status.workerStage)?status.workerStage:null};
            const pass=this.lastStatus.voiceFilter,voice=this.voiceBypass;
            const proof=status.phase==='ready'&&status.backend==='leap-openvpn-process'&&status.networkScope==='discord-process-ipv4'&&status.routesVerified===true&&status.isolationVerified===true&&status.normalRoutePreserved===true&&status.processRuleCount>=1&&
                (this.standby?status.routingActive===false&&status.standbyVerified===true:status.routingActive===true)&&
                (!voice||this.standby||pass?.verified===true&&pass.requested?.ip===voice.ip&&pass.requested?.port===voice.port);
            if(!proof){
                this.terminalFailure=SessionClient.terminalCode(status.failure)||(status.phase==='ready'?'CS_ISOLATION_ROUTES':'CS_AUTO_ROUTE_ENDED');
                this.state('verificação da rota falhou; restaurando conexão');this.stop().catch(()=>{});return false;
            }
            this.terminalFailure=null;this.lastVerifiedAt=Date.now();return true;
        }catch{if(!this.stopped&&!this.switching&&revision===this.routingRevision){this.terminalFailure='CS_HELPER_CONTROL';this.state('auxiliar não responde; aguardando restauração automática');this.stop().catch(()=>{});}return false;}
        finally{this.verifying=false;}
    }
    async ensureHelper(){
        if(this.stopped)throw this.error('CS_CANCELLED');
        this.state('verificando auxiliar integrado');
        const file=this.path.join(this.root,'CallShare-helper.exe');
        const expected='__CALLSHARE_HELPER_SHA256__';
        if(!this.fs.existsSync(file))throw this.error('CS_HELPER_MISSING');
        let actual;
        // BetterDiscord defaults readFileSync to UTF-8, unlike Node. Request binary explicitly.
        try{actual=this.crypto.createHash('sha256').update(this.fs.readFileSync(file,null)).digest('hex');}
        catch{throw this.error('CS_HELPER_READ');}
        if(actual!==expected)throw this.error('CS_HELPER_HASH');
        if(!await this.available()){
            if(this.retiringEndpoint){
                this.state('aguardando o auxiliar anterior encerrar');
                const previous=this.retiringEndpoint.instance,deadline=Date.now()+15000;
                while(this.readEndpoint()?.instance===previous){
                    if(this.stopped)throw this.error('CS_CANCELLED');
                    if(Date.now()>=deadline)throw this.error('CS_HELPER_BUSY');
                    await this.delay(100);
                }
                this.retiringEndpoint=null;
            }
            if(this.stopped)throw this.error('CS_CANCELLED');
            this.state('abrindo auxiliar integrado');
            let result;try{result=await this.launch(file);}catch{throw this.error('CS_HELPER_LAUNCH');}
            if(typeof result==='string'&&result)throw this.error('CS_HELPER_LAUNCH');
            const deadline=Date.now()+15000;
            while(Date.now()<deadline){
                if(await this.available())break;
                await this.delay(400);
            }
            if(!this.endpoint)throw this.error('CS_HELPER_TIMEOUT');
        }
        if(this.stopped){if(!this.isProbe)this.stopRemote().catch(()=>{});throw this.error('CS_CANCELLED');}
    }
    async probeProvider(){
        this.isProbe=true;
        try{await this.ensureHelper();if(this.stopped)throw this.error('CS_CANCELLED');
            const result=await this.command(this.endpoint,'/provider-check','POST');
            if(this.stopped)throw this.error('CS_CANCELLED');
            return providerCertificateInfo(result.providerCertificate);
        }finally{this.cancelProbe();}
    }
    cancelProbe(){if(!this.isProbe)return;this.stopped=true;clearInterval(this.heartbeat);this.heartbeat=null;}
    async start({voiceBypass=null,standby=false}={}){
        this.prepareDeadline=Date.now()+SESSION_LIMITS.prepareMs;
        const deadline=Date.now()+SESSION_LIMITS.prepareMs+SESSION_LIMITS.cleanupMs+SESSION_LIMITS.clientGraceMs;
        this.standby=standby===true;await this.ensureHelper();
        this.state('preparando VPN integrada sem conta');
        const voice=voiceBypass?routeEndpoint(voiceBypass.ip,voiceBypass.port):null;
        this.voiceBypass=voice;
        if(voiceBypass&&!voice)throw this.error('CS_VOICE_ENDPOINT');
        if(this.standby&&!voice)throw this.error('CS_VOICE_ENDPOINT');
        await this.command(this.endpoint,voice?`/${this.standby?'warm-voice':'start-voice'}/${voice.ip}/${voice.port}`:'/start','POST');
        while(Date.now()<deadline){
            if(this.stopped){this.stopRemote().catch(()=>{});throw this.error('CS_CANCELLED');}
            let info;try{info=await this.command(this.endpoint,'/status');}catch{throw this.error('CS_HELPER_CONTROL');}
            this.lastStatus={...this.nativeEvidence(info),...this.isolationEvidence(info),country:/^[A-Z]{2}$/.test(info.country||'')?info.country:null,routesVerified:info.routesVerified===true,
                workerStage:['idle','extracting','driver','adapter','isolating','address','connecting','connected','stopping','stopped','failed','cleanup-failed'].includes(info.workerStage)?info.workerStage:null};
            if(['failed','cleanup-failed'].includes(info.phase)){
                const known=new Set(['CS_PREPARE_TIMEOUT','CS_PROVIDER_NETWORK','CS_PROVIDER_HTTP','CS_PROVIDER_TIMEOUT','CS_PROVIDER_SIZE','CS_PROVIDER_FORMAT','CS_PROVIDER_POLICY','CS_PROVIDER_CA','CS_PROVIDER_IDENTITY','CS_PROVIDER_SERVICE','CS_PROVIDER_GATEWAY',
                    'CS_WORKER_UAC','CS_WORKER_MISSING','CS_WORKER_HASH','CS_WORKER_UNAVAILABLE','CS_WORKER_TOOL','CS_WORKER_TOOL_TIMEOUT','CS_WORKER_PROTOCOL','CS_WORKER_RUNTIME','CS_WORKER_DIRECTORY','CS_WORKER_ADAPTER','CS_WORKER_JOB',
                    'CS_SERVICE_MISSING','CS_SERVICE_ACCESS','CS_SERVICE_BUSY','CS_SERVICE_UNAVAILABLE','CS_SERVICE_PROTOCOL','CS_SERVICE_AUTH','CS_SERVICE_START','CS_SERVICE_PIPE','CS_SERVICE_INPUT','CS_SERVICE_LAUNCH','CS_ISOLATION_BASELINE','CS_ISOLATION_WFP','CS_ISOLATION_ROUTES','CS_ISOLATION_ROUTES','CS_DISCORD_PROCESS','CS_UDP_OWNER_TABLE','CS_PROCESS_DRIVER','CS_PROCESS_DRIVER_BUSY','CS_PROCESS_ROUTER','CS_PROCESS_CLEANUP',
                    'CS_PROBE_CONNECT','CS_PROBE_TIMEOUT','CS_PROBE_DNS','CS_PROBE_REFUSED','CS_PROXY_BIND','CS_PROXY_SOCKET','CS_PROXY_DENIED','CS_PROXY_INTERFACE','CS_PROXY_LOCAL_ADDRESS','CS_PROBE_NETWORK_UNREACHABLE','CS_PROBE_HOST_UNREACHABLE','CS_VPN_ADDRESS_NOT_READY','CS_PROBE_TARGET','CS_PROBE_TLS','CS_PROBE_HTTP','CS_PROXY_TARGET','CS_PROXY_NOT_READY','CS_PROXY_PROTOCOL','CS_PROXY_AUTH',
                    'CS_ROUTE_HEALTH','CS_VOICE_ENDPOINT','CS_VOICE_FILTER','CS_VPN_TLS','CS_VPN_CONFIG','CS_VPN_AUTH','CS_VPN_IDENTITY','CS_VPN_ADAPTER','CS_VPN_DCO','CS_VPN_DRIVER_NOT_READY',
                    'CS_VPN_ROUTES','CS_VPN_EXIT','CS_VPN_TIMEOUT','CS_VPN_CLEANUP','CS_GATEWAY_PROBE','CS_BRIDGE','CS_HELPER_INTERNAL']);
                throw this.error(known.has(info.failure)?info.failure:'CS_HELPER_INTERNAL');
            }
            const labels={provider:'obtendo conexão gratuita e certificados temporários',selection:'selecionando servidores em uma janela limitada',service:'acionando auxiliar instalado, sem nova autorização',extracting:'verificando componentes de rede',
                address:'aguardando o endereço da VPN ficar utilizável no Windows',driver:'preparando driver de rede assinado',isolating:'verificando isolamento do Discord e a conexão normal dos outros programas',adapter:'aguardando o adaptador de rede ficar disponível',connecting:'conectando ao servidor VPN',connected:'verificando rota IPv4',probe:'verificando acesso ao Discord pela VPN'};
            const providerName=this.lastStatus.provider?.selected?providerLabel(this.lastStatus.provider.selected):null;
            if(labels[info.phase])this.state((providerName?providerName+' · ':'')+labels[info.phase]);
            else if(info.phase==='ready'){
                if(info.backend!=='leap-openvpn-process'||info.networkScope!=='discord-process-ipv4'||info.routesVerified!==true||info.isolationVerified!==true||info.normalRoutePreserved!==true||info.processRuleCount<1)throw this.error('CS_VPN_ROUTES');
                if(this.standby?info.routingActive!==false||info.standbyVerified!==true:info.routingActive!==true)throw this.error('CS_PROCESS_ROUTER');
                if(!Number.isInteger(info.bridge?.port)||info.bridge.port<1024||info.bridge.port>65535||!/^[a-f0-9]{64}$/.test(info.bridge?.nonce))throw this.error('CS_HELPER_PROTOCOL');
                this.port=info.bridge.port;this.nonce=info.bridge.nonce;
                if(this.stopped){this.stopRemote().catch(()=>{});throw this.error('CS_CANCELLED');}
                this.lastVerifiedAt=Date.now();
                this.heartbeat=setInterval(()=>this.verifyActiveRoute(),5000);
                this.state('VPN pronta; aguardando nova sessão');return;
            }
            await this.delay(450);
        }
        await this.stop();throw this.error('CS_PREPARE_TIMEOUT');
    }
    async setRouting(active){
        if(this.stopped||this.switching)throw this.error('CS_CANCELLED');
        const expiry=Date.parse(this.lastStatus?.provider?.credentialExpiresAt);
        if(active&&Number.isFinite(expiry)&&Date.now()>=expiry-60000){
            this.terminalFailure='CS_PROVIDER_IDENTITY';await this.stop();throw this.error('CS_PROVIDER_IDENTITY');
        }
        this.routingRevision++;this.switching=true;
        if(!active){this.undoWebSocket?.();this.undoWebSocket=null;}
        try{
            const info=await this.command(this.endpoint,active?'/resume':'/pause','POST');
            if(this.stopped)throw this.error('CS_CANCELLED');
            this.lastStatus={...this.lastStatus,...this.isolationEvidence(info)};
            if(info.phase!=='ready'||!info.routesVerified||!info.isolationVerified||!info.normalRoutePreserved||info.routingActive!==active||!active&&!info.standbyVerified)throw this.error('CS_ISOLATION_ROUTES');
            const voice=this.voiceBypass,proof=this.lastStatus.voiceFilter;
            if(active&&voice&&(!proof?.verified||proof.requested?.ip!==voice.ip||proof.requested?.port!==voice.port))throw this.error('CS_VOICE_FILTER');
            this.standby=!active;this.lastVerifiedAt=Date.now();return true;
        }catch(e){this.stop().catch(()=>{});throw e;}
        finally{this.switching=false;}
    }
    installWebSocket(surface){
        if(!this.port||this.stopped||this.standby||this.undoWebSocket)throw this.error('CS_BRIDGE');
        const original=surface.WebSocket,owner=this;
        if(typeof original!=='function')throw this.error('CS_WEBSOCKET');
        const wrapper=new Proxy(original,{construct(target,args,newTarget){
            if(owner.stopped||owner.standby)return Reflect.construct(target,args,target);
            const gateway=SessionClient.gateway(args[0]);
            const rtcHost=SessionClient.rtcHost(args[0]);
            const url=gateway||(owner.scope==='rtc'?SessionClient.rtc(args[0]):null);
            const kind=gateway?'gateway':'rtc';
            const stats=owner.stats[kind],started=Date.now();
            let opened=false,failed=false;
            const evidence=event=>{if(!owner.stopped)owner.onEvidence(kind,event,owner.evidence());};
            const fail=()=>{if(!failed){failed=true;stats.failed++;owner.state(kind==='gateway'?'falha no gateway pela VPN integrada':'falha na sinalização RTC pela VPN integrada');evidence('erro');}};
            if(rtcHost){
                const port=Number(rtcHost.port||443);
                if(owner.rtcPorts.size<8)owner.rtcPorts.add(port);
                if(!url&&owner.scope==='rtc'&&!owner.unroutedRtcPorts.has(port)&&owner.unroutedRtcPorts.size<8){
                    owner.unroutedRtcPorts.add(port);
                    owner.state(`RTC na porta ${port} fora da ponte VPN`);evidence('porta fora da rota');
                }
            }
            if(url){
                if(owner.stopped)throw owner.error('CS_CANCELLED');
                stats.attempts++;
                args=[...args];args[0]=`ws://127.0.0.1:${owner.port}/${owner.nonce}?target=${encodeURIComponent(url.href)}`;
                owner.state(kind==='gateway'?'abrindo gateway pela VPN integrada':'abrindo sinalização RTC pela VPN integrada');
                evidence('tentativa');
            }
            let socket;
            try{socket=Reflect.construct(target,args,newTarget===wrapper?target:newTarget);}catch(error){if(url)fail();throw error;}
            if(url){
                socket.addEventListener('open',()=>{
                    if(owner.stopped)return;
                    opened=true;stats.opened++;stats.active++;stats.lastConnectMs=Math.max(0,Date.now()-started);
                    if(kind==='gateway')owner.routed++;
                    owner.state(kind==='gateway'?'gateway conectado pela VPN integrada':'sinalização RTC conectada pela VPN integrada');evidence('aberto');
                },{once:true});
                socket.addEventListener('error',()=>{if(!owner.stopped)fail();},{once:true});
                socket.addEventListener('close',event=>{
                    stats.closed++;if(opened)stats.active=Math.max(0,stats.active-1);else if(!owner.stopped)fail();
                    stats.lastCloseCode=Number.isInteger(event?.code)&&event.code>=0&&event.code<=65535?event.code:null;
                    evidence('fechado');
                },{once:true});
            }
            return socket;
        }});
        surface.WebSocket=wrapper;
        if(surface.WebSocket!==wrapper)throw this.error('CS_WEBSOCKET');
        this.undoWebSocket=()=>{if(surface.WebSocket===wrapper)surface.WebSocket=original;};
    }
    async stopRemote(){if(!this.endpoint){this.cleanupConfirmed=true;return;}
        try{const result=await this.command(this.endpoint,'/stop','POST');if(result.cleanupConfirmed!==true)throw Error();const provider=routeProvider(result.provider);this.lastStatus={...this.lastStatus,...(provider?{provider}:{}),networkAfter:routeNativeSnapshot(result.network)};this.cleanupConfirmed=true;}
        catch{throw this.error('CS_VPN_CLEANUP');}}
    stop(){
        if(this.stopPromise)return this.stopPromise;
        this.routingRevision++;this.stopped=true;clearInterval(this.heartbeat);this.heartbeat=null;
        this.undoWebSocket?.();this.undoWebSocket=null;
        return this.stopPromise=this.stopRemote();
    }
}

module.exports={SessionClient};
