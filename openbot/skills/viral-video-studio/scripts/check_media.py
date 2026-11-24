#!/usr/bin/env python3
"""Inspects an actual rendered MP4 through ffprobe and emits JSON. No external deps."""
import json,sys,subprocess,pathlib
if len(sys.argv)!=2: print('usage: check_media.py VIDEO.mp4');sys.exit(2)
p=pathlib.Path(sys.argv[1])
if not p.is_file():print('ERROR: file not found');sys.exit(2)
try:
    r=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate','-of','json',str(p)],capture_output=True,text=True,timeout=30,check=True)
    data=json.loads(r.stdout)
except (FileNotFoundError,subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError) as exc:
    print('ERROR: ffprobe unavailable or failed:',exc);sys.exit(2)
v=[s for s in data.get('streams',[]) if s.get('codec_type')=='video'];a=[s for s in data.get('streams',[]) if s.get('codec_type')=='audio']
checks={'video_stream':bool(v),'audio_stream':bool(a),'1080x1920':bool(v) and v[0].get('width')==1080 and v[0].get('height')==1920,'h264':bool(v) and v[0].get('codec_name')=='h264','aac':bool(a) and a[0].get('codec_name')=='aac'}
result={'file':str(p),'duration_seconds':float(data.get('format',{}).get('duration',0)),'checks':checks,'passed':all(checks.values()),'raw':data}
print(json.dumps(result,ensure_ascii=False,indent=2));sys.exit(0 if result['passed'] else 1)
