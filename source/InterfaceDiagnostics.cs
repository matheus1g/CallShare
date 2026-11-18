// Read-only interface metadata. One unavailable property must not hide later adapters.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Web.Script.Serialization;
internal static class InterfaceDiagnostics {
    internal sealed class Failure {public int ordinal;public string stage,category;public int? nativeCode;}
    internal sealed class Address {public IPAddress Ip;public Func<string> Dad;}
    internal sealed class Probe {
        public Func<bool> Supports,Up;public Func<int> Index,Mtu;
        public Func<IPAddress[]> Dns;public Func<Address[]> Addresses;
    }
    static Probe FromSystem(NetworkInterface nic){
        IPInterfaceProperties props=null;IPv4InterfaceProperties v4=null;
        Func<IPInterfaceProperties> properties=delegate{return props??(props=nic.GetIPProperties());};
        Func<IPv4InterfaceProperties> ipv4=delegate{return v4??(v4=properties().GetIPv4Properties());};
        return new Probe{
            Supports=delegate{return nic.Supports(NetworkInterfaceComponent.IPv4);},
            Index=delegate{var value=ipv4();if(value==null)throw new NotSupportedException();return value.Index;},
            Mtu=delegate{var value=ipv4();if(value==null)throw new NotSupportedException();return value.Mtu;},
            Up=delegate{return nic.OperationalStatus==OperationalStatus.Up;},
            Dns=delegate{var result=new List<IPAddress>();foreach(var ip in properties().DnsAddresses)if(ip.AddressFamily==AddressFamily.InterNetwork&&result.Count<8)result.Add(ip);return result.ToArray();},
            Addresses=delegate{var result=new List<Address>();foreach(var info in properties().UnicastAddresses){var owned=info;if(owned.Address.AddressFamily==AddressFamily.InterNetwork&&result.Count<32)result.Add(new Address{Ip=owned.Address,Dad=delegate{return owned.DuplicateAddressDetectionState.ToString();}});}return result.ToArray();}
        };
    }
    static IEnumerable<Probe> SystemProbes(){foreach(var nic in NetworkInterface.GetAllNetworkInterfaces())yield return FromSystem(nic);}
    static void Error(NetworkDiagnostics.Snapshot result,int ordinal,string stage,Exception error){
        int? code=null;var network=error as NetworkInformationException;var win32=error as Win32Exception;
        if(network!=null)code=network.NativeErrorCode;else if(win32!=null)code=win32.NativeErrorCode;
        string category=error is NotSupportedException?"unsupported":code==5?"denied":"unavailable";
        foreach(var previous in result.interfaceFailures)if(previous.ordinal==ordinal&&previous.stage==stage&&previous.nativeCode==code&&previous.category==category)return;
        result.interfaceError=1;result.interfacePartial=true;
        if(result.interfaceFailures.Count>=32){result.interfaceFailureOverflow++;return;}
        result.interfaceFailures.Add(new Failure{ordinal=ordinal,stage=stage,category=category,nativeCode=code});
    }
    static bool Read<T>(Func<T> get,NetworkDiagnostics.Snapshot result,int ordinal,string stage,out T value){
        try{if(get==null)throw new NotSupportedException();value=get();return true;}
        catch(Exception error){value=default(T);Error(result,ordinal,stage,error);return false;}
    }
    public static void Fill(NetworkDiagnostics.Snapshot result,int ownedIndex){Fill(result,ownedIndex,SystemProbes());}
    internal static void Fill(NetworkDiagnostics.Snapshot result,int ownedIndex,IEnumerable<Probe> probes){
        int ordinal=0;
        try{foreach(var probe in probes){
            if(ordinal>=64||result.interfaces.Count>=16){result.truncated=true;break;}
            int current=ordinal++;result.interfaceCount=ordinal;bool supported;
            if(!Read(probe.Supports,result,current,"capabilities",out supported)||!supported)continue;
            int indexValue,mtuValue;bool upValue;IPAddress[] dnsValue;Address[] addresses;
            int? index=Read(probe.Index,result,current,"index",out indexValue)?indexValue:(int?)null;
            int? mtu=Read(probe.Mtu,result,current,"mtu",out mtuValue)?mtuValue:(int?)null;
            bool? up=Read(probe.Up,result,current,"status",out upValue)?upValue:(bool?)null;
            List<string> dns=null;if(Read(probe.Dns,result,current,"dns",out dnsValue)&&dnsValue!=null){dns=new List<string>();foreach(var ip in dnsValue)if(ip!=null&&ip.AddressFamily==AddressFamily.InterNetwork&&dns.Count<8)dns.Add(ip.ToString());}
            if(!Read(probe.Addresses,result,current,"addresses",out addresses)||addresses==null)continue;
            foreach(var address in addresses){
                if(result.interfaces.Count>=16){result.truncated=true;break;}
                if(address==null||address.Ip==null||address.Ip.AddressFamily!=AddressFamily.InterNetwork)continue;
                string dad;Read(address.Dad,result,current,"address-state",out dad);
                result.interfaces.Add(new NetworkDiagnostics.Nic{ip=address.Ip.ToString(),index=index,mtu=mtu,up=up,dad=dad,dns=dns,tunnel=index.HasValue&&index.Value==ownedIndex});
            }
        }}catch(Exception error){Error(result,ordinal,"enumerate",error);}
    }
    static Probe Good(){return new Probe{Supports=()=>true,Index=()=>7,Mtu=()=>1500,Up=()=>true,Dns=()=>new[]{IPAddress.Parse("1.1.1.1")},Addresses=()=>new[]{new Address{Ip=IPAddress.Parse("192.168.1.2"),Dad=()=>"Preferred"}}};}
    public static void SelfTest(){
        var broken=Good();broken.Supports=delegate{throw new Win32Exception(5,"private-adapter-name");};
        var partial=Good();partial.Dns=delegate{throw new NotSupportedException("private-dns");};partial.Addresses=()=>new[]{new Address{Ip=IPAddress.Parse("192.168.1.3"),Dad=delegate{throw new Win32Exception(87,"private-state");}}};
        var result=new NetworkDiagnostics.Snapshot();Fill(result,7,new[]{broken,partial,Good()});
        if(result.interfaces.Count!=2||result.interfaceCount!=3||result.interfaceFailures.Count!=3||result.interfaces[0].dad!=null||result.interfaces[0].dns!=null||result.interfaces[1].mtu!=1500||result.interfaces[1].tunnel!=true)throw new Exception("Interface partial collection regression");
        string json=new JavaScriptSerializer().Serialize(result);if(json.Contains("private-"))throw new Exception("Interface error privacy");
        var many=new List<Probe>();for(int i=0;i<100;i++)many.Add(broken);result=new NetworkDiagnostics.Snapshot();Fill(result,7,many);
        if(result.interfaceFailures.Count!=32||result.interfaceFailureOverflow!=32||!result.truncated)throw new Exception("Interface error bounds");
        many.Clear();for(int i=0;i<20;i++)many.Add(Good());result=new NetworkDiagnostics.Snapshot();Fill(result,7,many);if(result.interfaces.Count!=16||!result.truncated)throw new Exception("Interface row bounds");
    }
    public static void ReadOnlyCheck(){var result=new NetworkDiagnostics.Snapshot();Fill(result,0);Console.WriteLine(new JavaScriptSerializer().Serialize(new{adapters=result.interfaceCount,addresses=result.interfaces.Count,partial=result.interfacePartial,failures=result.interfaceFailures,overflow=result.interfaceFailureOverflow}));}
}
