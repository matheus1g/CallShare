// Read shipped BetterDiscord code only. Run its patch dispatcher in an isolated
// test context, with fake gateway/media/routing; no Discord session or VPN access.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {StreamBootstrap}=require('./stream-bootstrap.cjs');
(async()=>{
    const bdFile=process.argv[2]||path.join(process.env.APPDATA,'BetterDiscord','data','betterdiscord.asar');
    const pluginFile=process.argv[3]||path.join(require('./release-path.cjs').releasePath(),'CallShare.plugin.js');
    let source;
    if(bdFile.endsWith('.asar')){
        const bytes=fs.readFileSync(bdFile),headerSize=bytes.readUInt32LE(4),jsonSize=bytes.readUInt32LE(12);
        const entry=JSON.parse(bytes.subarray(16,16+jsonSize).toString()).files['betterdiscord.js'];
        source=bytes.subarray(8+headerSize+Number(entry.offset),8+headerSize+Number(entry.offset)+entry.size).toString();
    }else source=fs.readFileSync(bdFile,'utf8');
    const start=source.indexOf('static makeOverride(e){'),end=source.indexOf('static rePatch(e)',start);
    if(start<0||end<start)throw Error('Unrecognized installed patch dispatcher');
    const method=source.slice(start+'static '.length,end),logger=/\b([A-Za-z_$][\w$]*)\.err\("Patcher"/.exec(method)?.[1];
    if(!logger)throw Error('Unrecognized installed patch logger');
    const makeOverride=vm.runInNewContext('(function '+method+')',{
        [logger]:{err(){throw Error('Unexpected patch callback exception');}}
    });
    const points=new WeakMap();
    function patch(type,object,key,callback){
        let methods=points.get(object);if(!methods){methods=new Map();points.set(object,methods);}
        let point=methods.get(key);
        if(!point){point={functionName:key,originalFunction:object[key],children:[]};methods.set(key,point);object[key]=makeOverride(point);}
        const child={caller:'CallShare test',type,callback};point.children.push(child);
        return ()=>{point.children=point.children.filter(c=>c!==child);if(!point.children.length){object[key]=point.originalFunction;methods.delete(key);}};
    }
    const Patcher=Object.fromEntries(['before','instead','after'].map(type=>[type,(_name,obj,key,callback)=>patch(type,obj,key,callback)]));
    const context=vm.createContext({module:{exports:{}},BdApi:{Patcher},console});
    vm.runInContext(fs.readFileSync(pluginFile,'utf8'),context,{filename:pluginFile});
    const plugin=new context.module.exports(),sent=[];
    const gateway={
        send(kind,args){assert.equal(this,gateway);sent.push([kind,...args]);},
        streamCreate(...args){const data={preferred_region:args[3]};this.send('create',args);},
        streamWatch(...args){const data={stream_key:args[0]};this.send('watch',args);},
        streamDelete(){},isSessionEstablished(){return true;}
    };
    Object.assign(plugin,{routeStrategy:'on-demand',autoPolicy:{enabled:true,pausedCall:null},manualDemandCall:null,
        region:'automatic',cleanups:[],generation:1,running:true,record(){},voiceChannelId:()=> 'test-call',streamConnections:()=>[]});
    let ready=false;
    plugin.bootstrap=new StreamBootstrap({context:()=>({call:'test-call',enabled:true,paused:false,ready,active:ready}),
        prepare:async()=>{await Promise.resolve();ready=true;},restore:async()=>{ready=false;},read:()=>null});
    plugin.attachGateway(gateway);assert.equal(plugin.gatewayTarget,gateway);
    // Preserve composition with another instead patch on the same gateway.
    const other=patch('instead',gateway,'streamWatch',(receiver,args,next)=>next.apply(receiver,args));
    assert.equal(gateway.streamWatch('test-stream'),undefined);assert.equal(sent.length,0);
    await plugin.bootstrap.task;assert.deepEqual(sent,[['watch','test-stream']]);
    assert.equal(plugin.bootstrap.report().history.some(r=>r.stage==='request-failed'),false);
    gateway.streamCreate('guild','test-guild','test-channel','brazil');assert.deepEqual(sent[1],['create','guild','test-guild','test-channel','brazil']);
    plugin.autoPolicy.enabled=false;gateway.streamWatch('test-direct');assert.deepEqual(sent[2],['watch','test-direct']);
    for(const undo of plugin.cleanups)undo();other();
    console.log('PASS: installed BetterDiscord dispatcher; deferred WATCH, CREATE, disabled-mode bypass, and another instead patch preserve the native gateway receiver. No network, service or VPN started.');
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
