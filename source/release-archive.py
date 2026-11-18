from pathlib import Path
import hashlib,json,sys,zipfile
root=Path(sys.argv[1]).resolve();target=Path(sys.argv[2]).resolve()
workspace=Path(__file__).resolve().parents[2]
assert root.is_relative_to(workspace/'work'/'next'/'build'/'staging')
assert target.is_relative_to(workspace/'work'/'next'/'build'/'staging')
manifest=json.loads((root/'SHA256.json').read_text(encoding='utf-8'))
for name,digest in manifest['files'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,name
with zipfile.ZipFile(target,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file():z.write(p,p.relative_to(root).as_posix())
with zipfile.ZipFile(target) as z:
    assert set(z.namelist())==set(manifest['files'])|{'SHA256.json'}
    for name in z.namelist():assert z.read(name)==(root/name).read_bytes(),name
    for name,digest in manifest['files'].items():assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
print(json.dumps({'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'entries':len(manifest['files'])+1}))
