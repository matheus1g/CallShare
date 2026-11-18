// Shared, data-only contract. No Node or Discord APIs in this module.
var SESSION_LIMITS=Object.freeze({prepareMs:300000,attemptMs:130000,cleanupMs:95000,clientGraceMs:15000,
    selectionMs:2500,selectionCandidates:8,selectionConnections:4,selectionSocketMs:2000});
function providerLabel(id){return ({riseup:'Riseup',coopvpn:'CoopVPN'})[id]||'VPN';}
if(typeof module!=='undefined')module.exports={SESSION_LIMITS,providerLabel};
