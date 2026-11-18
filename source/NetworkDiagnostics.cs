// Bounded metadata for validated Discord processes and this relay only. No payload capture.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Threading;

internal sealed class RelayLedger {
    internal sealed class Row {public string ip,protocol;public int port;public long txBytes,rxBytes,txPackets,rxPackets,first,last;}
    readonly object gate=new object();readonly Dictionary<string,Row> rows=new Dictionary<string,Row>();
    public long Overflow;
    public void Add(string protocol,IPEndPoint endpoint,int bytes,bool outbound){
        if(endpoint==null||bytes<0)return;string key=protocol+":"+endpoint;
        lock(gate){Row row;if(!rows.TryGetValue(key,out row)){
            if(rows.Count>=96){Overflow++;return;}
            row=new Row{ip=endpoint.Address.ToString(),port=endpoint.Port,protocol=protocol,first=NetworkDiagnostics.Now()};rows.Add(key,row);
        }row.last=NetworkDiagnostics.Now();if(outbound){row.txBytes+=bytes;row.txPackets++;}else{row.rxBytes+=bytes;row.rxPackets++;}}
    }
    public Row[] Snapshot(){lock(gate){var result=new List<Row>();foreach(var r in rows.Values)result.Add(new Row{ip=r.ip,port=r.port,protocol=r.protocol,txBytes=r.txBytes,rxBytes=r.rxBytes,txPackets=r.txPackets,rxPackets=r.rxPackets,first=r.first,last=r.last});return result.ToArray();}}
}
internal static class NetworkDiagnostics {
    internal sealed class Tcp {public int pid,localPort,remotePort,state;public string localIp,remoteIp;}
    internal sealed class Udp {public int pid,localPort;public string localIp;}
    internal sealed class Nic {public string ip,dad;public int? index,mtu;public bool tunnel;public bool? up;public List<string> dns;}
    internal sealed class Route {public string destination,mask,nextHop;public uint index,metric;public bool tunnel;}
    internal sealed class Snapshot {public string stage;public long at;public uint tcpError,udpError,routeError,interfaceError;public int processCount,processReadFailures,interfaceCount,interfaceFailureOverflow;public bool interfacePartial;public List<InterfaceDiagnostics.Failure> interfaceFailures=new List<InterfaceDiagnostics.Failure>();public bool truncated;public List<Route> routes=new List<Route>();public List<Tcp> tcp=new List<Tcp>();public List<Udp> udp=new List<Udp>();public List<Nic> interfaces=new List<Nic>();public RelayLedger.Row[] relays;public long relayOverflow;public object voicePass,udpRelay;}
    public static long Now(){return (DateTime.UtcNow.Ticks-621355968000000000L)/10000;}
    public static Snapshot Capture(List<string> targets,int ownedIndex,RelayLedger ledger,object voicePass,object udpRelay=null){
        var result=new Snapshot{at=Now(),relays=ledger==null?new RelayLedger.Row[0]:ledger.Snapshot(),relayOverflow=ledger==null?0:Interlocked.Read(ref ledger.Overflow),voicePass=voicePass,udpRelay=udpRelay};
        var pids=new HashSet<int>();foreach(var process in Process.GetProcessesByName("Discord"))using(process)try{if(targets.Exists(path=>String.Equals(path,process.MainModule.FileName,StringComparison.OrdinalIgnoreCase)))pids.Add(process.Id);}catch{result.processReadFailures++;}result.processCount=pids.Count;
        Read(false,pids,result);Read(true,pids,result);
        try{uint normal=SplitGuard.DefaultIndex();foreach(var row in SplitGuard.Routes())if(row.Index==normal||row.Index==(uint)ownedIndex){
            if(result.routes.Count>=96){result.truncated=true;break;}
            result.routes.Add(new Route{destination=new IPAddress(BitConverter.GetBytes(row.Destination)).ToString(),mask=new IPAddress(BitConverter.GetBytes(row.Mask)).ToString(),nextHop=new IPAddress(BitConverter.GetBytes(row.NextHop)).ToString(),index=row.Index,metric=row.Metric,tunnel=row.Index==(uint)ownedIndex});
        }}catch{result.routeError=1;}
        InterfaceDiagnostics.Fill(result,ownedIndex);
        return result;
    }
    static void Read(bool udp,HashSet<int> pids,Snapshot result){
        int bytes=0;uint error=udp?GetExtendedUdpTable(IntPtr.Zero,ref bytes,false,2,1,0):GetExtendedTcpTable(IntPtr.Zero,ref bytes,false,2,5,0);
        if(bytes<4||bytes>4*1024*1024){if(udp)result.udpError=error;else result.tcpError=error;return;}
        IntPtr data=Marshal.AllocHGlobal(bytes);
        try{error=udp?GetExtendedUdpTable(data,ref bytes,false,2,1,0):GetExtendedTcpTable(data,ref bytes,false,2,5,0);
            if(udp)result.udpError=error;else result.tcpError=error;if(error!=0)return;
            int stride=udp?12:24,count=Marshal.ReadInt32(data);if(count<0||count>(bytes-4)/stride){if(udp)result.udpError=13;else result.tcpError=13;return;}
            for(int i=0;i<count;i++){int at=4+i*stride,pid=Marshal.ReadInt32(data,at+(udp?8:20));if(!pids.Contains(pid))continue;
                if(udp){if(result.udp.Count>=96){result.truncated=true;continue;}result.udp.Add(new Udp{pid=pid,localIp=Ip(data,at),localPort=Port(data,at+4)});}
                else{if(result.tcp.Count>=96){result.truncated=true;continue;}result.tcp.Add(new Tcp{pid=pid,state=Marshal.ReadInt32(data,at),localIp=Ip(data,at+4),localPort=Port(data,at+8),remoteIp=Ip(data,at+12),remotePort=Port(data,at+16)});}
            }
        }finally{Marshal.FreeHGlobal(data);}
    }
    static string Ip(IntPtr ptr,int at){var b=new byte[4];Marshal.Copy(IntPtr.Add(ptr,at),b,0,4);return new IPAddress(b).ToString();}
    static int Port(IntPtr ptr,int at){return Marshal.ReadByte(ptr,at)*256+Marshal.ReadByte(ptr,at+1);}
    public static void SelfTest(){var ledger=new RelayLedger();ledger.Add("udp",new IPEndPoint(IPAddress.Parse("8.8.8.8"),50000),100,true);ledger.Add("udp",new IPEndPoint(IPAddress.Parse("8.8.8.8"),50000),40,false);var rows=ledger.Snapshot();if(rows.Length!=1||rows[0].txBytes!=100||rows[0].rxPackets!=1)throw new Exception("Relay metadata counters");rows[0].txBytes=0;if(ledger.Snapshot()[0].txBytes!=100)throw new Exception("Relay snapshot alias");for(int i=1;i<=100;i++)ledger.Add("tcp",new IPEndPoint(IPAddress.Parse("1.1.1.1"),i),1,true);if(ledger.Snapshot().Length!=96||ledger.Overflow!=5)throw new Exception("Relay metadata bound");}
    [DllImport("iphlpapi.dll")]static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool sorted,int family,int tableClass,uint reserved);
    [DllImport("iphlpapi.dll")]static extern uint GetExtendedUdpTable(IntPtr table,ref int size,bool sorted,int family,int tableClass,uint reserved);
}
