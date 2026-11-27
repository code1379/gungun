package manager
import (
 "errors"
 "fmt"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
)
func serviceCommandPath(name string, fallback ...string) (string, bool) {
	if path, err := exec.LookPath(name); err == nil { return path, true }
	for _, path := range fallback {
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() && info.Mode().Perm()&0111 != 0 { return path, true }
	}
	return "", false
}
func (m *Manager) serviceBackend() (string,error) {
	if m.InitSystem!="" {
		if m.InitSystem=="systemd" || m.InitSystem=="openrc" { return m.InitSystem,nil }
		return "",fmt.Errorf("unsupported service manager: %s",m.InitSystem)
	}
	if _,e:=os.Stat("/run/systemd/system"); e==nil {
		if _,ok:=serviceCommandPath("systemctl","/usr/bin/systemctl","/bin/systemctl");ok{return "systemd",nil}
	}
	_,a:=serviceCommandPath("rc-service","/sbin/rc-service","/usr/sbin/rc-service")
	_,b:=serviceCommandPath("rc-update","/sbin/rc-update","/usr/sbin/rc-update")
	_,c:=serviceCommandPath("openrc-run","/sbin/openrc-run","/usr/sbin/openrc-run")
	if a&&b&&c{return "openrc",nil}
	return "",errors.New("unsupported service manager: requires systemd or OpenRC (Alpine Linux)")
}
func (m *Manager) runServiceCommand(name string,args ...string)([]byte,error){
	var fallback []string
	switch name {
	case "systemctl": fallback=[]string{"/usr/bin/systemctl","/bin/systemctl"}
	case "journalctl": fallback=[]string{"/usr/bin/journalctl","/bin/journalctl"}
	case "rc-service": fallback=[]string{"/sbin/rc-service","/usr/sbin/rc-service"}
	case "rc-update": fallback=[]string{"/sbin/rc-update","/usr/sbin/rc-update"}
	default:return nil,fmt.Errorf("unknown service command: %s",name)
	}
	path:=name
	if m.InitSystem=="" { var ok bool;path,ok=serviceCommandPath(name,fallback...);if !ok{return nil,fmt.Errorf("service command %s not found in PATH or standard paths",name)} }
	return m.Command(path,args...)
}
func (m *Manager) ServiceAction(name,action string)([]byte,error){
 allowed:=map[string]bool{"gungun-sing-box":true,"gungun-caddy":true,"gungun-tunnel":true,"warp-svc":true}; if !allowed[name]{return nil,fmt.Errorf("invalid service: %s",name)}
 switch action {case "start","stop","restart","status","enable","disable":default:return nil,fmt.Errorf("invalid action: %s",action)}
 backend,e:=m.serviceBackend();if e!=nil{return nil,e}
 if backend=="systemd" { if action=="status"{return m.runServiceCommand("systemctl","is-active",name)};return m.runServiceCommand("systemctl",action,name) }
 if action=="enable"{return m.runServiceCommand("rc-update","add",name,"default")}
 if action=="disable"{_,_=m.runServiceCommand("rc-service","--ifstarted",name,"stop");return m.runServiceCommand("rc-update","del",name,"default")}
 if action=="stop"{_,_=m.runServiceCommand("rc-update","del",name,"default");return m.runServiceCommand("rc-service","--ifstarted",name,"stop")}
 if action=="restart" {
   if _,e:=m.runServiceCommand("rc-update","add",name,"default");e!=nil{return nil,e}
   out,e:=m.runServiceCommand("rc-service",name,"restart");if e==nil{return out,nil}
   started,se:=m.runServiceCommand("rc-service",name,"start");if se==nil{return started,nil}
   return nil,errors.Join(e,se)
 }
 if action=="start"{if _,e:=m.runServiceCommand("rc-update","add",name,"default");e!=nil{return nil,e}}
 return m.runServiceCommand("rc-service",name,action)
}
func (m *Manager) ServiceLogs(name string,lines int)([]byte,error){
 if lines<1{lines=50};if lines>500{lines=500};backend,e:=m.serviceBackend();if e!=nil{return nil,e}
 if backend=="systemd"{return m.runServiceCommand("journalctl","-u",name,"-n",fmt.Sprint(lines),"--no-pager","-o","short-iso")}
 path:=filepath.Join("/var/log",name+".log");b,e:=os.ReadFile(path);if e!=nil{return nil,fmt.Errorf("OpenRC log unavailable at %s: %w",path,e)};rows:=strings.Split(strings.TrimSpace(string(b)),"\n");if len(rows)>lines{rows=rows[len(rows)-lines:]};return []byte(strings.Join(rows,"\n")),nil
}
func (m *Manager) InstallServices()error{
 backend,e:=m.serviceBackend();if e!=nil{return e}
 commands:=map[string]string{"gungun-sing-box":m.Bin+"/sing-box run -c "+m.Root+"/sing-box.json","gungun-caddy":m.Bin+"/caddy run --config "+m.Root+"/caddy.json","gungun-tunnel":m.Bin+"/cloudflared tunnel --no-autoupdate run"}
 if backend=="systemd"{
  for name,cmd:=range commands{data:="[Unit]\nDescription=Gungun managed "+name+"\nAfter=network-online.target\nWants=network-online.target\nConditionPathExists="+m.Root+"/state.json\nConditionPathExists="+m.Root+"/"+strings.TrimPrefix(name,"gungun-")+".enabled\n[Service]\nExecStart="+cmd+"\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nProtectHome=true\nProtectSystem=full\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n";if e:=AtomicWrite("/etc/systemd/system/"+name+".service",[]byte(data),0644);e!=nil{return e}}
  if _,e:=m.runServiceCommand("systemctl","daemon-reload");e!=nil{return e};for name:=range commands{if _,e:=m.ServiceAction(name,"enable");e!=nil{return e}};return nil
 }
 for name,cmd:=range commands{
  parts:=strings.SplitN(cmd," ",2);args:="";if len(parts)==2{args=parts[1]}
  data:="#!/sbin/openrc-run\nname=\""+name+"\"\ncommand=\""+parts[0]+"\"\ncommand_args=\""+args+"\"\ncommand_background=true\npidfile=\"/run/${RC_SVCNAME}.pid\"\noutput_log=\"/var/log/"+name+".log\"\nerror_log=\"/var/log/"+name+".log\"\ndepend() { need net; }\n"
  if e:=AtomicWrite("/etc/init.d/"+name,[]byte(data),0755);e!=nil{return e};if _,e:=m.ServiceAction(name,"enable");e!=nil{return e}
 };return nil
}
func (m *Manager) UninstallServices()error{backend,e:=m.serviceBackend();if e!=nil{return e};for _,name:=range []string{"gungun-sing-box","gungun-caddy","gungun-tunnel"}{_,_=m.ServiceAction(name,"disable");if backend=="systemd"{_ = os.Remove("/etc/systemd/system/"+name+".service")}else{_ = os.Remove("/etc/init.d/"+name)}};if backend=="systemd"{_,e=m.Command("systemctl","daemon-reload")};return e}
