// Original CallShare provider adapter. It never installs a driver or changes routes.
const https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto'),net=require('node:net');
const ENDPOINTS=Object.freeze({provider:'https://riseup.net/provider.json',ca:'https://black.riseup.net/ca.crt',
  service:'https://api.black.riseup.net/3/config/eip-service.json',identity:'https://api.black.riseup.net/3/cert'});
function failure(code){return Object.assign(new Error(code),{code});}
function publicIPv4(value){
  if(net.isIP(value)!==4)return false;
  const [a,b,c]=value.split('.').map(Number);
  return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&
    !(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&
    !(a===192&&b===0&&[0,2].includes(c))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&
    !(a===203&&b===0&&c===113);
}
function request(url,{method='GET',providerCA,signal}={}){
  if(!Object.values(ENDPOINTS).includes(url)||!['GET','POST'].includes(method))return Promise.reject(failure('CS_PROVIDER_DESTINATION'));
  return new Promise((resolve,reject)=>{
    const roots=tls.getCACertificates?.('default')||tls.rootCertificates;
    // The upstream Bitmask client also combines system roots and its provider CA.
    const req=https.request(url,{method,rejectUnauthorized:true,minVersion:'TLSv1.2',signal,
      ...(providerCA?{ca:[...roots,providerCA]}:{}),timeout:15000,
      headers:{'User-Agent':'CallShare/0.9.0',...(method==='POST'?{'Content-Length':'0'}:{})}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy(failure('CS_PROVIDER_SIZE'));else chunks.push(chunk);});
      res.on('error',()=>{clearTimeout(deadline);reject(failure('CS_PROVIDER_NETWORK'));});
      res.on('end',()=>{clearTimeout(deadline);res.statusCode===200?resolve(Buffer.concat(chunks)):reject(failure('CS_PROVIDER_HTTP'));});
    });
    const deadline=setTimeout(()=>req.destroy(failure('CS_PROVIDER_TIMEOUT')),20000);
    deadline.unref?.();
    req.once('close',()=>clearTimeout(deadline));
    req.on('timeout',()=>req.destroy(failure('CS_PROVIDER_TIMEOUT')));
    req.on('error',error=>{clearTimeout(deadline);reject(failure(['CS_PROVIDER_SIZE','CS_PROVIDER_TIMEOUT'].includes(error.code)?error.code:'CS_PROVIDER_NETWORK'));});
    req.end();
  });
}
class PreparedRiseupSession {
  #identity;
  #ca;
  constructor(discovery,identity){
    this.provider=discovery.provider||'riseup';this.gateways=discovery.gateways;this.#ca=discovery.ca.toString();this.#identity=identity;
    this.expiresAt=identity.expiresAt;
    this.caExpiresAt=new Date(new crypto.X509Certificate(discovery.ca).validTo).toISOString();
    Object.freeze(this);
  }
  toJSON(){return {provider:this.provider,identityReady:Boolean(this.#identity),expiresAt:this.expiresAt,caExpiresAt:this.caExpiresAt,
    gatewayCount:this.gateways.length,countries:[...new Set(this.gateways.map(g=>g.country))]};}
  profile(index=0){
    if(!this.#identity)throw failure('CS_PROVIDER_IDENTITY');
    const gateway=Number.isInteger(index)&&index>=0?this.gateways[index]:null;if(!gateway)throw failure('CS_PROVIDER_GATEWAY');
    // Never pass provider JSON options verbatim to a privileged OpenVPN process.
    const lines=['client','dev tun','proto udp4',`remote ${gateway.ip} ${gateway.port}`,'nobind','persist-key',
      'remote-cert-tls server','auth SHA512','cipher AES-256-GCM','data-ciphers AES-256-GCM',
      'tls-version-min 1.2','tls-cipher TLS-ECDHE-ECDSA-WITH-AES-256-GCM-SHA384',
      'keepalive 10 30','auth-nocache','script-security 1','verb 3',
      '<ca>',this.#ca.trim(),'</ca>','<cert>',this.#identity.cert.trim(),'</cert>',
      '<key>',this.#identity.key.trim(),'</key>',''];
    return Buffer.from(lines.join('\n'));
  }
  dispose(){this.#identity=null;}
}
class RiseupBootstrap {
  constructor({fetch=request,now=()=>Date.now()}={}){this.fetch=fetch;this.now=now;}
  json(body){try{return JSON.parse(body.toString());}catch{throw failure('CS_PROVIDER_FORMAT');}}
  validateProvider(provider){
    let api;try{api=new URL(provider?.api_uri).href;}catch{throw failure('CS_PROVIDER_POLICY');}
    if(provider?.domain!=='riseup.net'||provider.api_version!=='3'||
      api!=='https://api.black.riseup.net/'||provider.ca_cert_uri!==ENDPOINTS.ca||
      provider.service?.allow_anonymous!==true||provider.service?.allow_free!==true||
      !Array.isArray(provider.services)||!provider.services.includes('openvpn')||
      !/^SHA256: [a-f0-9]{64}$/.test(provider.ca_cert_fingerprint))throw failure('CS_PROVIDER_POLICY');
  }
  inspectCA(pem,fingerprint){
    const blocks=(typeof pem==='string'||Buffer.isBuffer(pem)?pem.toString():'').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
    if(!blocks.length||blocks.length>8)return {status:'invalid',validated:false};
    let selected;
    for(const block of blocks){
      try{const cert=new crypto.X509Certificate(block),digest=crypto.createHash('sha256').update(cert.raw).digest('hex');
        if('SHA256: '+digest===fingerprint){selected={cert,fingerprint:digest};break;}
      }catch{}
    }
    if(!selected)return {status:'fingerprint-mismatch',validated:false};
    const cert=selected.cert,from=Date.parse(cert.validFrom),until=Date.parse(cert.validTo),now=this.now();
    if(!cert.ca||!Number.isFinite(from)||!Number.isFinite(until))return {status:'invalid',validated:false};
    const status=now<from?'not-yet-valid':now>=until?'expired':until-now<=7*86400000?'expiring':'ready';
    return {...selected,status,validated:['ready','expiring'].includes(status),validFrom:new Date(from).toISOString(),expiresAt:new Date(until).toISOString(),certificateCount:blocks.length};
  }
  validateCA(pem,fingerprint){
    const inspected=this.inspectCA(pem,fingerprint);
    if(!inspected.validated)throw failure('CS_PROVIDER_CA');
    return inspected.cert;
  }
  async checkCertificate({signal}={}){
    try{
      const provider=this.json(await this.fetch(ENDPOINTS.provider,{signal}));this.validateProvider(provider);
      const inspected=this.inspectCA(await this.fetch(ENDPOINTS.ca,{signal}),provider.ca_cert_fingerprint);
      const {cert,...metadata}=inspected;
      return {provider:'riseup',checkedAt:this.now(),...metadata};
    }catch{return {provider:'riseup',checkedAt:this.now(),status:'unavailable',validated:false};}
  }
  gateways(service){
    if(!Array.isArray(service?.gateways)||service.gateways.length>2000||!service.locations||
      service.openvpn_configuration?.['data-ciphers']!=='AES-256-GCM'||
      service.openvpn_configuration?.auth!=='SHA512'||
      service.openvpn_configuration?.['tls-version-min']!=='1.2')throw failure('CS_PROVIDER_SERVICE');
    const result=[],seen=new Set();
    for(const gateway of service.gateways){
      const country=service.locations[gateway.location]?.country_code;
      if(!/^[A-Z]{2}$/.test(country)||country==='BR'||!publicIPv4(gateway.ip_address))continue;
      for(const transport of Array.isArray(gateway.capabilities?.transport)?gateway.capabilities.transport:[]){
        if(transport?.type!=='openvpn'||!Array.isArray(transport.protocols)||!transport.protocols.includes('udp'))continue;
        const ports=Array.isArray(transport.ports)?transport.ports:[];
        const port=ports.map(p=>typeof p==='string'&&/^\d{1,5}$/.test(p)?Number(p):null).find(p=>p>0&&p<=65535&&p!==53);
        const key=gateway.ip_address+':'+port;
        if(!port||seen.has(key))continue;seen.add(key);result.push(Object.freeze({ip:gateway.ip_address,port,country,tcp:transport.protocols.includes('tcp')}));
      }
    }
    if(!result.length)throw failure('CS_PROVIDER_GATEWAY');
    return Object.freeze(result);
  }
  async discover({signal}={}){
    const provider=this.json(await this.fetch(ENDPOINTS.provider,{signal}));
    this.validateProvider(provider);
    const caBody=await this.fetch(ENDPOINTS.ca,{signal});
    const ca=Buffer.from(this.validateCA(caBody,provider.ca_cert_fingerprint).toString());
    const service=this.json(await this.fetch(ENDPOINTS.service,{signal,providerCA:ca}));
    const gateways=this.gateways(service);
    return Object.freeze({ca,gateways});
  }
  validateIdentity(body,ca){
    try{
      const text=body.toString();
      const certs=text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];
      const keys=text.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g)||[];
      if(certs.length!==1||keys.length!==1)throw Error();
      const cert=new crypto.X509Certificate(certs[0]),issuer=new crypto.X509Certificate(ca),key=crypto.createPrivateKey(keys[0]);
      // The authenticated provider API issues the client identity. Its issuing CA
      // may differ from the server-trust CA, which authenticates the VPN server.
      // The VPN server validates the client chain; we validate key pairing/validity here.
      if(!cert.checkPrivateKey(key)||cert.ca||
        this.now()<Date.parse(cert.validFrom)||this.now()>=Date.parse(cert.validTo))throw Error();
      return {cert:cert.toString(),key:key.export({type:'pkcs8',format:'pem'}),expiresAt:new Date(Math.min(Date.parse(cert.validTo),Date.parse(issuer.validTo))).toISOString()};
    }catch{throw failure('CS_PROVIDER_IDENTITY');}
  }
  async prepare({signal}={}){
    const discovery=await this.discover({signal});
    const body=await this.fetch(ENDPOINTS.identity,{method:'POST',signal,providerCA:discovery.ca});
    try{return new PreparedRiseupSession(discovery,this.validateIdentity(body,discovery.ca));}
    finally{body.fill(0);}
  }
}
module.exports={RiseupBootstrap,PreparedRiseupSession,ENDPOINTS,publicIPv4,requestProviderEndpoint:request};
