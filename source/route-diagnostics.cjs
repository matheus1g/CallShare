// Metadata only. Never retain arbitrary Discord objects, packet contents or URL queries.
const routeIp = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) &&
    value.split('.').every(x => Number(x) <= 255) ? value : null;
const routePort = value => Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
const routePublicIp = value => {
    if (!routeIp(value)) return null;
    const [a,b,c] = value.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a===100 && b>=64 && b<=127) &&
        !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && (b===168 || b===0 && (c===0 || c===2))) &&
        !(a===198 && (b===18 || b===19 || b===51 && c===100)) && !(a===203 && b===0 && c===113) ? value : null;
};
function routeEndpoint(ip,port) { return routePublicIp(ip) && routePort(port) ? {ip,port} : null; }
function routeProvider(value) {
    if(!value||typeof value!=='object'||value.policy!=='riseup-first')return null;
    const stamp=n=>Number.isSafeInteger(n)&&n>=0?n:null;
    const id=s=>['riseup','coopvpn'].includes(s)?s:null;
    const date=s=>typeof s==='string'&&s.length<40&&Number.isFinite(Date.parse(s))?new Date(s).toISOString():null;
    return {policy:'riseup-first',preferred:'riseup',selected:id(value.selected),
        connectedAt:stamp(value.connectedAt),endedAt:stamp(value.endedAt),sessionAgeMs:stamp(value.sessionAgeMs),
        activeMs:stamp(value.activeMs),standbyMs:stamp(value.standbyMs),switches:stamp(value.switches),
        relayTxBytes:stamp(value.relayTxBytes),relayRxBytes:stamp(value.relayRxBytes),relayCounterAt:stamp(value.relayCounterAt),
        relayCountersPartial:value.relayCountersPartial===true,relayCounterUnit:'application-relay-bytes',
        credentialExpiresAt:date(value.credentialExpiresAt),caExpiresAt:date(value.caExpiresAt),
        declaredSessionLimitSeconds:null,limitKnowledge:'not-published',
        stopReason:['requested','transport-failure','prepare-failed','cancelled','credential-expiring'].includes(value.stopReason)?value.stopReason:null,
        attempts:(Array.isArray(value.attempts)?value.attempts:[]).slice(0,2).map(a=>({provider:id(a?.provider),startedAt:stamp(a?.startedAt),endedAt:stamp(a?.endedAt),
            result:['preparing','ready','failed','cancelled'].includes(a?.result)?a.result:null,
            timings:(Array.isArray(a?.timings)?a.timings:[]).slice(0,20).filter(t=>['provider','selection','worker','service','extracting','driver','adapter','isolating','address','connecting','connected','probe','bridge'].includes(t?.stage)&&Number.isSafeInteger(t.ms)&&t.ms>=0).map(t=>({stage:t.stage,ms:t.ms})),
            failure:/^CS_[A-Z_]{1,50}$/.test(a?.failure||'')?a.failure:null,cleanupConfirmed:a?.cleanupConfirmed===true}))};
}
function routeControl(value) {
    if (typeof value !== 'string' || value.length > 200) return null;
    try { const u = new URL(value.includes('://') ? value : 'wss://'+value);
        return u.protocol==='wss:' && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash &&
            /^[a-z0-9-]+\.discord\.(?:media|gg)$/.test(u.hostname) ? {host:u.hostname,port:Number(u.port)||443} : null;
    } catch { return null; }
}
function routeEnvironment(value) {
    const version=x=>typeof x==='string'&&/^\d+(?:\.\d+){1,3}$/.test(x)&&x.length<40?x:null;
    return {windows:version(value?.windows),node:version(value?.node),arch:['x64','arm64','ia32'].includes(value?.arch)?value.arch:null};
}
function routeHealth(value){if(!value||typeof value!=='object')return null;const stamp=n=>Number.isSafeInteger(n)&&n>=0?n:null;return {lastCheck:stamp(value.lastCheck),lastSuccess:stamp(value.lastSuccess),failures:Number.isInteger(value.failures)&&value.failures>=0&&value.failures<=2?value.failures:0,checking:value.checking===true,intervalMs:30000};}
function routeRouterLifecycle(value) {
    if(!value||typeof value!=='object'||value.strategy!=='adapter-modes-keep-udp')return null;
    const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=1000000?n:null;
    const sdkUdpStartFailures = count(value.sdkUdpStartFailures);
    return {strategy:'adapter-modes-keep-udp',engineStarts:count(value.engineStarts),pauses:count(value.pauses),resumes:count(value.resumes),
        activeAdapters:Number.isInteger(value.activeAdapters)&&value.activeAdapters>=0&&value.activeAdapters<=32?value.activeAdapters:null,paused:value.paused===true,
        ...(sdkUdpStartFailures === null ? {} : {sdkUdpStartFailures})};
}
function routeVoiceProof(value) {
    if(!value||typeof value!=='object')return null;
    const count=n=>Number.isSafeInteger(n)&&n>=0?n:0;
    return {requested:routeEndpoint(value.ip??value.requested?.ip,value.port??value.requested?.port),verified:value.verified===true,
        stage:['requested','open','insert-in','insert-out','read-size','size','read-table','mismatch','verified'].includes(value.stage)?value.stage:null,
        nativeCode:Number.isInteger(value.nativeCode)&&value.nativeCode>=0&&value.nativeCode<=4294967295?value.nativeCode:null,
        filterCount:count(value.filterCount),matchesIn:value.matchesIn===true,matchesOut:value.matchesOut===true,
        packetsIn:count(value.packetsIn),packetsOut:count(value.packetsOut),bytesIn:count(value.bytesIn),bytesOut:count(value.bytesOut)};
}
function routeMediaMetrics(stats) {
    const select=(obj,keys)=>Object.fromEntries(keys.filter(k=>typeof obj?.[k]==='number'&&Number.isFinite(obj[k])&&obj[k]>=0).map(k=>[k,obj[k]]));
    const inbound=stats?.rtp?.inbound,received=Array.isArray(inbound)?inbound:inbound&&typeof inbound==='object'?Object.values(inbound).flat():[];
    const rows=items=>Array.isArray(items)?items.slice(0,512).filter(r=>r?.type==='audio'||r?.type==='video').slice(0,32).map(r=>({type:r.type,...select(r,['bytesSent','bytesReceived','packetsSent','packetsReceived','packetsLost','jitter','bitrate','framesEncoded','framesDecoded','frameRateEncode','frameRateDecode','frameRateRender','encryptSuccessCount','encryptFailureCount'])})):[];
    return {transport:select(stats?.transport,['ping','transportDelayMs','availableOutgoingBitrate','inboundBitrateEstimate','transportPacketCount','routingFailures','decryptionFailures','jitter','packetLossRate']),outbound:rows(stats?.rtp?.outbound),inbound:rows(received)};
}
function routeUdpRelay(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const nativeError = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
    const safe = {
        associateRequests:count(value.associateRequests),
        associationsReady:count(value.associationsReady),
        localDatagrams:count(value.localDatagrams),
        invalidDatagrams:count(value.invalidDatagrams),
        ownerRejected:count(value.ownerRejected),
        destinationRejected:count(value.destinationRejected),
        setupErrors:count(value.setupErrors),
        sendErrors:count(value.sendErrors),
        replyErrors:count(value.replyErrors),
        sent:count(value.sent),
        replies:count(value.replies),
        lastSocketError:nativeError(value.lastSocketError),
        lastOwnerTableError:nativeError(value.lastOwnerTableError)
    };
    return Object.values(safe).some(n => n !== null) ? safe : null;
}
function routeNativeSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const time = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    const list = (rows,max,project) => Array.isArray(rows) ? rows.slice(0,max).map(project).filter(Boolean) : [];
    return {at:time(value.at),stage:['before-router','active','standby','after-stop','cleanup-failed'].includes(value.stage)?value.stage:null,tcpError:time(value.tcpError),udpError:time(value.udpError),
        truncated:value.truncated===true,ipv6Coverage:'not-collected',routeError:time(value.routeError),interfaceError:time(value.interfaceError),processCount:count(value.processCount),processReadFailures:count(value.processReadFailures),
        interfaceCount:count(value.interfaceCount),interfacePartial:value.interfacePartial===true||value.interfaceError>0,interfaceFailureOverflow:count(value.interfaceFailureOverflow),
        interfaceFailures:list(value.interfaceFailures,32,r=>Number.isInteger(r?.ordinal)&&r.ordinal>=0&&r.ordinal<=64&&['enumerate','capabilities','index','mtu','status','dns','addresses','address-state'].includes(r.stage)?{ordinal:r.ordinal,stage:r.stage,category:['unsupported','denied','unavailable'].includes(r.category)?r.category:null,nativeCode:Number.isInteger(r.nativeCode)&&r.nativeCode>=0&&r.nativeCode<=4294967295?r.nativeCode:null}:null),
        routes:list(value.routes,96,r=>routeIp(r?.destination)&&routeIp(r?.mask)&&routeIp(r?.nextHop)?{destination:r.destination,mask:r.mask,nextHop:r.nextHop,index:count(r.index),metric:count(r.metric),tunnel:r.tunnel===true}:null),
        tcp:list(value.tcp,96,r => routeIp(r?.localIp) && routeIp(r?.remoteIp) && routePort(r?.localPort) && routePort(r?.remotePort) ?
            {pid:count(r.pid),localIp:r.localIp,localPort:r.localPort,remoteIp:r.remoteIp,remotePort:r.remotePort,state:count(r.state)} : null),
        udp:list(value.udp,96,r => routeIp(r?.localIp) && routePort(r?.localPort) ? {pid:count(r.pid),localIp:r.localIp,localPort:r.localPort,remoteEndpoint:'unavailable-in-owner-table'} : null),
        interfaces:list(value.interfaces,16,r => routeIp(r?.ip) ? {ip:r.ip,index:Number.isInteger(r.index)&&r.index>0?r.index:null,mtu:Number.isInteger(r.mtu)&&r.mtu>0&&r.mtu<=65535?r.mtu:null,dad:['Preferred','Tentative','Duplicate','Deprecated','Invalid'].includes(r.dad)?r.dad:null,dns:Array.isArray(r.dns)?r.dns.filter(routeIp).slice(0,8):null,tunnel:r.tunnel===true,up:typeof r.up==='boolean'?r.up:null} : null),
        relays:list(value.relays,96,r => routePublicIp(r?.ip) && routePort(r?.port) && ['tcp','udp'].includes(r.protocol) ?
            {ip:r.ip,port:r.port,protocol:r.protocol,counterUnit:r.protocol==='udp'?'datagrams':'stream-io-operations',txBytes:count(r.txBytes),rxBytes:count(r.rxBytes),txPackets:count(r.txPackets),rxPackets:count(r.rxPackets),first:time(r.first),last:time(r.last),path:'vpn-bound-socket'} : null),
        relayOverflow:count(value.relayOverflow),voicePass:routeVoiceProof(value.voicePass),udpRelay:routeUdpRelay(value.udpRelay)};
}
class RouteDiagnostics {
    constructor(now=()=>Date.now()) { this.now=now;this.started=now();this.ids=new WeakMap();this.serial=0;this.connections=[];this.events=[];this.samples=[];this.native=[];this.dropped={connections:0,events:0,samples:0,native:0}; }
    push(key,row,limit) { const list=this[key];list.push(row);if(list.length>limit){list.shift();this.dropped[key]++;} }
    observe(connection,role,state,payload,stage='snapshot') {
        if (!connection || typeof connection!=='object') return null;
        let row=this.ids.get(connection);
        if (!row) { row={id:'rtc-'+(++this.serial),first:this.now(),coverage:stage==='ready'?'ready-observed':'attached-after-creation'};this.ids.set(connection,row); }
        row.role=['voice','send','receive'].includes(role)?role:'unknown';row.last=this.now();row.active=true;
        if(!this.connections.includes(row)){
            this.connections.push(row);
            if(this.connections.length>48){
                let discard=this.connections.findIndex(item=>!item.active);
                if(discard<0)discard=this.connections.findIndex(item=>item.role!=='voice');
                if(discard<0)discard=0;
                this.connections.splice(discard,1);this.dropped.connections++;
            }
        }
        row.protocol=['udp','tcp'].includes(connection.protocol)?connection.protocol:null;
        row.state=['DISCONNECTED','AWAITING_ENDPOINT','AUTHENTICATING','CONNECTING','RTC_DISCONNECTED','RTC_CONNECTING','RTC_CONNECTED','NO_ROUTE','ICE_CHECKING','DTLS_CONNECTING'].includes(state)?state:'unknown';
        const fromReady=payload && routeEndpoint(payload.ip,payload.port);
        const fromObject=routeEndpoint(connection.ip,connection.port);
        const hasSfu='_sfuEndpoint' in connection,fromSfu=routeEndpoint(connection._sfuEndpoint?.address,connection._sfuEndpoint?.port);
        if(payload?.clear===true){row.media=null;row.endpointSource='native-sfu-cleared';}
        else if(fromReady){row.media=fromReady;row.endpointSource='native-ready';}
        else if(hasSfu){row.media=fromSfu;row.endpointSource='native-sfu-field';}
        else if(fromObject && row.endpointSource!=='native-ready'){row.media=fromObject;row.endpointSource='connection-ip-port';}
        row.control=routeControl(connection.endpoint)||routeControl(connection.hostname)||null;
        if(stage!=='snapshot')this.event(stage,row.id);
        return row;
    }
    reconcile(active) { for(const row of this.connections)row.active=active.has(row.id); }
    event(kind,id=null) { if(!['ready','sfu','connect','disconnect','prepare-full','prepare-voice','restore','voice-changed','endpoint-overlap','test-pass','test-fail','auto-start','auto-ready','auto-fail'].includes(kind))return;
        this.push('events',{at:this.now(),kind,id:/^rtc-\d+$/.test(id||'')?id:null},256); }
    sample(voicePing,streams,voiceStats) { this.push('samples',{at:this.now(),voicePing:Number.isFinite(voicePing)&&voicePing>=0?voicePing:null,voice:routeMediaMetrics(voiceStats),
        streams:Array.isArray(streams)?streams.slice(0,12).map(r=>({id:/^rtc-\d+$/.test(r.id||'')?r.id:null,framesEncoded:Number.isSafeInteger(r.framesEncoded)?r.framesEncoded:null,framesDecoded:Number.isSafeInteger(r.framesDecoded)?r.framesDecoded:null,metrics:routeMediaMetrics(r.stats)})):[]},128); }
    captureNative(value) { const safe=routeNativeSnapshot(value);if(!safe || safe.at==null || this.native.some(r=>r.at===safe.at))return;this.push('native',safe,24); }
    clearRecords() {this.started=this.now();this.events=[];this.samples=[];this.native=[];this.connections=this.connections.filter(r=>r.active);this.dropped={connections:0,events:0,samples:0,native:0};}
    plan({allowStreams=false,allowPendingStreams=false}={}) {
        const live=this.connections.filter(r=>r.active),voice=live.filter(r=>r.role==='voice');
        if(voice.length!==1 || !voice[0].media || voice[0].state!=='RTC_CONNECTED')return {eligible:false,reason:'voice-endpoint-unconfirmed'};
        if(voice[0].protocol!=='udp')return {eligible:false,reason:'voice-protocol-unconfirmed'};
        const streams=live.filter(r=>r.role==='send'||r.role==='receive');
        if(streams.length&&!allowStreams)return {eligible:false,reason:'stream-already-active'};
        if(streams.some(r=>(!r.media||r.protocol!=='udp')&&!(allowPendingStreams&&r.state!=='RTC_CONNECTED')))return {eligible:false,reason:'stream-endpoint-unconfirmed'};
        if(streams.some(r=>liveOverlap(r,live)))return {eligible:false,reason:'voice-stream-overlap'};
        return {eligible:true,reason:'preserve-current-voice-experiment',voice:{...voice[0].media},id:voice[0].id};
    }
    report(mode='off') {
        const latest=this.native.reduce((last,row)=>!last||row.at>last.at?row:last,null),voice=this.connections.find(r=>r.active&&r.role==='voice'),pass=latest?.voicePass;
        const correlations=this.connections.filter(r=>r.media).map(r=>({rtc:r.id,role:r.role,media:r.media,
            matchingVpnRelays:(latest?.relays||[]).filter(flow=>flow.protocol==='udp'&&flow.ip===r.media.ip&&flow.port===r.media.port)}));
        return {schema:1,started:this.started,at:this.now(),mode,dropped:{...this.dropped},
            coverage:{rtc:'native-ready-or-connection-fields',windows:'bounded-discord-ipv4-snapshots-while-worker-running',udpRemote:'from-native-ready-and-vpn-relays; owner-table-has-local-port-only',
                route:'policy-and-filter-counters; endpoint-match-is-correlation-not-packet-proof',requests:'websocket-handshakes-and-transport-metadata-only',payloads:'never-collected',ipv6:'not-collected'},
            findings:{unknownMediaEndpoints:this.connections.filter(r=>r.active&&!r.media).length,
                voicePassVerified:mode==='voice-direct'&&pass?.verified===true&&pass.requested?.ip===voice?.media?.ip&&pass.requested?.port===voice?.media?.port,
                voiceRulePackets:pass?(pass.packetsIn+pass.packetsOut):null,
                overlappingRtcIds:this.connections.filter(r=>r.active&&liveOverlap(r,this.connections)).map(r=>r.id)},
            correlations,plan:this.plan(),connections:this.connections.map(row=>({...row,path:!row.active?'historical':['off','standby'].includes(mode)?'normal-policy':mode==='voice-direct'&&row.role==='voice'?'direct-pass-policy; confirm-filter-counters':mode==='voice-direct'&&liveOverlap(row,this.connections)?'overlap-stop-required':'vpn-policy; confirm-relay-match'})),
            events:this.events,samples:this.samples,native:[...this.native].sort((a,b)=>a.at-b.at)};
    }
}
function liveOverlap(row,rows) { return row.role!=='voice' && row.media && rows.some(r=>r.active&&r.role==='voice'&&r.media?.ip===row.media.ip&&r.media?.port===row.media.port); }
if(typeof module!=='undefined')module.exports={RouteDiagnostics,routeIp,routePort,routePublicIp,routeEndpoint,routeProvider,routeControl,routeEnvironment,routeHealth,routeRouterLifecycle,routeVoiceProof,routeMediaMetrics,routeNativeSnapshot};
