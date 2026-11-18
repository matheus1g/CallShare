// Presentation only. No Discord, network or DOM access.
function panelActions(c){
  const out={primary:'Preparar agora',action:'connect',disabled:false,secondary:'Encerrar túnel e pausar nesta call',secondaryDisabled:!c.hasRoute};
  if(!c.call)return {...out,primary:'Aguardando call',action:'none',disabled:true,secondaryDisabled:true};
  if(c.restoring)return {...out,primary:'Aguarde a restauração',action:'none',disabled:true,secondaryDisabled:true};
  if(c.verifying)return {...out,primary:'Confirmando imagem',action:'none',disabled:true};
  if(c.preparing)return {...out,primary:'Cancelar preparo',action:'pause',secondaryDisabled:true};
  if(c.active&&c.onDemand)return {...out,primary:'Voltar à espera',action:'standby'};
  if(c.standby)return {...out,primary:'Pausar nesta call',action:'pause',secondaryDisabled:true};
  if(c.active)return {...out,primary:'Encerrar e pausar nesta call',action:'pause',secondaryDisabled:true};
  if(c.paused)return {...out,primary:'Retomar',action:'connect',secondaryDisabled:true};
  if(c.failure)return {...out,primary:'Tentar novamente',action:'connect',secondaryDisabled:true};
  return out;
}
// Values supplied by the existing client only; no new probes or media checks.
function panelPresentation(c){
  let title='Conexão normal',description='Prepare a conexão para iniciar ou abrir uma tela.',shortcut='Preparar',shortcutAction='connect',tone='normal',icon='screen';
  if(c.mediaAttention&&(c.standby||c.active)){
    title='Confira a transmissão';description=c.technicalDescription||'Feche e abra novamente a transmissão pelos controles do Discord para tentar de novo.';shortcut='Conferir tela';shortcutAction='panel';tone='attention';icon='warning';
  }else if(c.tone==='attention'){
    title=c.technicalTitle||'A conexão precisa de atenção';description='Confira os detalhes em Avançado ou copie o relatório.';shortcut='Reconectar';tone='attention';icon='warning';
  }else if(c.restoring){
    title='Voltando à conexão normal';description='Aguarde o encaminhamento terminar.';shortcut='Restaurando';tone='working';icon='spinner';
  }else if(!c.call&&!c.hasRoute){
    title='Aguardando call';description=c.automatic?'A conexão será preparada ao entrar na call.':'Entre em uma call para preparar a conexão.';shortcut='Aguardando call';
  }else if(c.verifying){
    title='Confirmando imagem';description='Conexão normal. A continuidade da imagem ainda está sendo verificada.';shortcut='Confirmando';tone='working';icon='spinner';
  }else if(c.paused){
    title='Pausado nesta call';description='Use Retomar para deixar o túnel disponível novamente.';shortcut='Pausado';icon='pause';
  }else if(c.mediaStarting){
    title='Iniciando a tela';description='O encaminhamento será temporário enquanto a mídia começa.';shortcut='Iniciando';tone='working';icon='spinner';
  }else if(c.standby){
    title='Túnel em espera';description='Inicie ou abra uma tela pelos controles do Discord.';shortcut='Em espera';tone='ready';icon='check';
  }else if(c.active){
    title='Encaminhamento ativo';description='O Discord está usando o túnel neste momento.';shortcut='Ativo';tone='ready';icon='screen';
  }else if(c.preparing){
    title='Preparando túnel';description='Aguarde a conexão ficar disponível.';shortcut='Preparando';tone='working';icon='spinner';
  }else if(c.automatic){
    title='Aguardando a voz';description='A preparação começa quando a conexão de voz estiver estável.';shortcut='Aguardando voz';tone='working';icon='spinner';
  }
  const voice=!c.call?'Sem call':c.fullRouting?'Pelo túnel':c.voiceDirect?'Direta':c.voiceConnected?'Não confirmada':'Conectando';
  const tunnel=c.restoring?'Restaurando':c.standby?'Em espera':c.active?'Encaminhando':c.preparing?'Preparando':c.hasRoute?'Não confirmado':'Desligado';
  const sharing=c.verifying?'Confirmando imagem':c.mediaAttention?'Não confirmado':c.mediaStarting?'Iniciando':c.sending&&c.receiving?'Enviando e assistindo':c.sending?'Enviando':c.receiving?'Assistindo':c.hasStreams?'Conectando':'Inativo';
  return {title,description,shortcut,shortcutAction,tone,icon,voice,tunnel,sharing,voiceTone:c.voiceDirect&&c.call?'ready':c.fullRouting?'attention':'normal',
    tunnelTone:c.restoring||c.preparing&&!c.active&&!c.standby?'working':c.standby||c.active?'ready':'normal',
    sharingTone:c.verifying||c.mediaStarting?'working':c.mediaAttention?'attention':'normal'};
}
if(typeof module!=='undefined')module.exports={panelActions,panelPresentation};
