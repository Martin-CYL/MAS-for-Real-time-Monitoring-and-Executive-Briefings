#!/usr/bin/env python3
"""Host-only account provisioning. Run with sudo; never mount Docker into a tenant.
Usage: nex-accounts.py ROOT init --origin https://dev.example.com --app-image nex-web:TAG --gateway-image nex-gateway:TAG
       nex-accounts.py ROOT invite EMAIL --name NAME [--import-data OLD_DATA] [--codex-auth AUTH_JSON]
       nex-accounts.py ROOT reset EMAIL
       nex-accounts.py ROOT render
After provisioning: docker compose -p nex-development-accounts -f ROOT/compose.json up -d
"""
import argparse, json, os, pathlib, secrets, shutil, subprocess
os.umask(0o077)
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('root',type=pathlib.Path);p.add_argument('action',choices=['init','invite','reset','render','activate'])
p.add_argument('email',nargs='?');p.add_argument('--name');p.add_argument('--origin');p.add_argument('--app-image');p.add_argument('--gateway-image');p.add_argument('--port',type=int,default=3211)
p.add_argument('--skills-dir',type=pathlib.Path)
p.add_argument('--import-data',type=pathlib.Path);p.add_argument('--codex-auth',type=pathlib.Path)
a=p.parse_args();root=a.root.resolve();root.mkdir(parents=True,exist_ok=True)
def write(path,value):
    path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o600)
def owner_tree(path,uid):
    for current,dirs,files in os.walk(path):
        os.chown(current,uid,uid)
        for f in files: os.chown(os.path.join(current,f),uid,uid,follow_symlinks=False)
if a.action=='init':
    if (root/'config.json').exists(): raise SystemExit('Already initialized')
    if not all([a.origin,a.app_image,a.gateway_image]):raise SystemExit('Origin and both images required')
    write(root/'config.json',dict(origin=a.origin,app_image=a.app_image,gateway_image=a.gateway_image,port=a.port))
    (root/'gateway').mkdir(mode=0o700)
    (root/'gateway.env').write_text('NEX_PUBLIC_ORIGIN='+a.origin+'\nNEX_AUTH_SECRET='+secrets.token_urlsafe(48)+'\n')
    write(root/'gateway'/'tenants.json',[]);owner_tree(root/'gateway',10002)
config=json.loads((root/'config.json').read_text())
registry=root/'gateway'/'tenants.json'
tenants=json.loads(registry.read_text())
if a.action in ('invite','reset'):
    if not a.email:raise SystemExit('Email required')
    command=['docker','run','--rm','--env-file',str(root/'gateway.env'),'-v',str(root/'gateway')+':/data',config['gateway_image'],'bun','/app/gateway/entry.ts',a.action,a.email]
    if a.name: command.append(a.name)
    result=subprocess.run(command,check=True,capture_output=True,text=True)
    info=json.loads(result.stdout.strip().splitlines()[-1]);uid=info['userId']
    if a.action=='invite':
        target=root/'users'/uid/'data'
        if a.import_data:
            # Stop the source service before importing. Never delete the original.
            shutil.copytree(a.import_data,target,symlinks=True)
        else:
            for folder in ('nex','codex','projects'): (target/folder).mkdir(parents=True,mode=0o700)
            if a.codex_auth:shutil.copy2(a.codex_auth,target/'codex'/'auth.json')
        if a.skills_dir:
            shutil.copytree(a.skills_dir,target/'codex'/'skills',dirs_exist_ok=True)
        (target/'projects'/'nex-workspace').mkdir(parents=True,exist_ok=True)
        owner_tree(target,10001)
        tenants.append(dict(userId=uid,upstream='http://user-'+uid+':3210',password=secrets.token_urlsafe(48)))
        write(registry,tenants);os.chown(registry,10002,10002)
    print(json.dumps(dict(userId=uid,linkFile=str(root/'gateway'/'invitations'/(uid+'.txt')),expiresIn='1 hour')))
services={};networks={}
for tenant in tenants:
    uid=tenant['userId'];name='user-'+uid;networks[name]={}
    data=root/'users'/uid/'data'
    services[name]=dict(image=config['app_image'],init=True,user='10001:10001',restart='unless-stopped',stop_grace_period='60s',mem_limit='1200m',pids_limit=256,cap_drop=['ALL'],security_opt=['no-new-privileges:true'],networks=[name],environment=dict(HOME='/home/nex',CODEX_HOME='/home/nex/.codex',NEX_RUNTIME_PROFILE='prod',NEX_DEFAULT_PROVIDER='codex',NEX_PROJECTS_DIR='/workspace/projects',NODE_ENV='production',TZ='Asia/Hong_Kong',NEX_PASSWORD=tenant['password']),volumes=[dict(type='bind',source=str(data/folder),target=dest,bind=dict(create_host_path=False)) for folder,dest in [('nex','/home/nex/.nex'),('codex','/home/nex/.codex'),('projects','/workspace/projects')]],healthcheck=dict(test=['CMD','bun','-e',"const r=await fetch('http://localhost:3210/health');if(!r.ok)process.exit(1)"],interval='30s',timeout='5s',start_period='30s',retries=3),logging=dict(driver='json-file',options={'max-size':'10m','max-file':'3'}))
services['gateway']=dict(image=config['gateway_image'],restart='unless-stopped',init=True,user='10002:10002',env_file=[str(root/'gateway.env')],ports=['127.0.0.1:'+str(config['port'])+':3220'],volumes=[str(root/'gateway')+':/data'],networks=list(networks) or ['gateway'],mem_limit='256m',pids_limit=128,cap_drop=['ALL'],security_opt=['no-new-privileges:true'],healthcheck=dict(test=['CMD','bun','-e',"const r=await fetch('http://localhost:3220/health');if(!r.ok)process.exit(1)"],interval='30s',timeout='5s',retries=3),logging=dict(driver='json-file',options={'max-size':'10m','max-file':'3'}))
if not networks:networks['gateway']={}
write(root/'compose.json',dict(services=services,networks=networks))

if a.action=='activate':
    compose=['docker','compose','-p','nex-'+root.parent.name+'-accounts','-f',str(root/'compose.json')]
    subprocess.run(compose+['up','-d'],check=True)
    subprocess.run(compose+['restart','gateway'],check=True)
    bootstrap=r"""
    const origin='http://127.0.0.1:3210';
    let response;
    for(let i=0;i<20;i++){try {response=await fetch(origin+'/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:process.env.NEX_PASSWORD})});if(response.ok)break;}catch{}await Bun.sleep(1000)}
    if(!response?.ok)throw new Error('Workspace not ready');
    const cookie=response.headers.getSetCookie().find(x=>x.startsWith('nex_session=')).split(';')[0];
    const ws=new WebSocket('ws://127.0.0.1:3210/ws',{headers:{Origin:origin,Cookie:cookie}});
    const timer=setTimeout(()=>process.exit(1),20000);
    ws.onopen=()=>ws.send(JSON.stringify({v:1,type:'command',id:'bootstrap',command:{type:'project.open',localPath:'/workspace/projects/nex-workspace'}}));
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id==='bootstrap'&&m.type==='ack'){clearTimeout(timer);ws.close();console.log('Workspace ready');process.exit(0)}if(m.id==='bootstrap'&&m.type==='error')process.exit(1)};
    """
    for tenant in tenants:
        subprocess.run(compose+['exec','-T','user-'+tenant['userId'],'bun','-e',bootstrap],check=True)
