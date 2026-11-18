// Read the exact source bundled into the release helper. Exercise public provider
// preparation with a FAKE worker/probe/bridge. Never invoke the Windows service.
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
(async()=>{
  const file=require('./release-path.cjs').releasePath()+'/CallShare-runtime/source/CallShare-helper.cjs',source=fs.readFileSync(file,'utf8');
  const boundary=source.lastIndexOf('__modules.helper.runCallShareHelper(');assert.ok(boundary>0);
  const modules=vm.runInNewContext(source.slice(0,boundary)+'\n__modules;',{
    require,Buffer,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,URL,process,console});
  let payloads=0,identity;
  class FakeBroker{
    constructor(){this.last={};}
    async start(payload){
      payloads++;const c=new crypto.X509Certificate(payload.cert),ca=new crypto.X509Certificate(payload.ca),key=crypto.createPrivateKey(payload.key);
      assert.equal(c.checkPrivateKey(key),true);assert.equal(c.ca,false);assert.equal(ca.ca,true);
      assert.ok(Date.parse(c.validTo)>Date.now());assert.ok(Date.parse(ca.validTo)>Date.now());
      assert.ok(payload.servers.length>0&&payload.servers.every(s=>modules.provider.publicIPv4(s.ip)&&s.country!=='BR'));
      identity={keyPairValid:true,keyType:key.asymmetricKeyType,expiresAt:new Date(c.validTo).toISOString(),caExpiresAt:new Date(ca.validTo).toISOString()};
      return {country:payload.servers[0].country,isolationVerified:true,normalRoutePreserved:true};
    }
    async stop(){this.cleanupConfirmed=true;}
  }
  class PublicOnlyTransport extends modules.vpn.VpnTransport{
    constructor(options){super({...options,Broker:FakeBroker});}
    async choose(gateways){return gateways.slice(0,4);}
    async probeGateway(){} // FAKE: no TCP/UDP media or Discord egress is tested.
    async listen(){this.port=45678;this.nonce='a'.repeat(64);}
  }
  const route=new modules.providers.ProviderTransport({root:'.',Transport:PublicOnlyTransport,standby:true,voiceBypass:{ip:'8.8.8.8',port:50000}});
  try{
    await route.start();const selected=route.providerEvidence();assert.ok(['riseup','coopvpn'].includes(selected.selected));assert.equal(payloads,1);
    if(selected.selected==='coopvpn')assert.equal(selected.attempts[0].failure,'CS_PROVIDER_CA');
    await route.stop();assert.equal(route.cleanupConfirmed,true);
    const result={checkedAt:new Date().toISOString(),bundledSource:true,provider:route.providerEvidence(),identity,
      worker:'FAKE',discordProbe:'FAKE',bridge:'FAKE',actualVPNStarted:false,actualServiceStarted:false,actualMediaTested:false};
    fs.writeFileSync('work/next/build/live-fallback-0140.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  }finally{await route.stop();}
})().catch(error=>{console.error(JSON.stringify({failed:true,code:/^CS_[A-Z_]+$/.test(error.code||'')?error.code:error.name}));process.exitCode=1;});
