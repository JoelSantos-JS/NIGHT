#!/usr/bin/env python3
"""Offline temporal + structural storyboard validator; no third-party deps."""
import json, sys, math
from pathlib import Path

def validate(data):
    errors=[]
    for key in ('job_id','title','language','style','duration_seconds','fps','width','height','scenes'):
        if key not in data: errors.append(f'missing {key}')
    if errors: return errors
    if data['style'] not in ('stickman-2d','motion-graphics','3d-stylized'): errors.append('invalid style')
    if any(type(data[k]) not in (int,float) or isinstance(data[k],bool) or not math.isfinite(data[k]) for k in ('duration_seconds','fps','width','height')):
        return errors + ['duration/fps/width/height must be finite numbers']
    if data['duration_seconds']<=0 or data['duration_seconds']>180: errors.append('duration outside supported range')
    if data['fps']<24 or data['fps']>60: errors.append('fps outside supported range')
    if data['width']!=1080 or data['height']!=1920: errors.append('MVP requires 1080x1920')
    if not isinstance(data['scenes'],list) or not data['scenes']: return errors+['scenes empty or invalid']
    previous=0.; ids=set()
    for i,s in enumerate(data['scenes']):
        if not isinstance(s,dict): errors.append(f'scene {i} not object');continue
        for k in ('id','start_seconds','end_seconds','visual','action','voiceover','onscreen_text'):
            if k not in s: errors.append(f'scene {i} missing {k}')
        if 'start_seconds' not in s or 'end_seconds' not in s: continue
        start,end=s['start_seconds'],s['end_seconds']
        if type(start) not in (int,float) or type(end) not in (int,float) or not math.isfinite(start) or not math.isfinite(end): errors.append(f'scene {i}: invalid timing');continue
        if end<=start: errors.append(f'scene {i} end <= start')
        if abs(start-previous)>0.034: errors.append(f'scene {i} gap or overlap; expected {previous}, got {start}')
        previous=end
        if s.get('id') in ids: errors.append(f'scene {i} repeated id')
        ids.add(s.get('id'))
    if abs(previous-data['duration_seconds'])>0.034: errors.append('last scene end != duration')
    return errors

if __name__=='__main__':
    if len(sys.argv)!=2: print('usage: validate_storyboard.py storyboard.json');sys.exit(2)
    try: data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    except Exception as exc: print(f'ERROR: {exc}');sys.exit(2)
    errs=validate(data)
    if errs:
        print('INVALID:');[print('- '+e) for e in errs];sys.exit(1)
    print('VALID storyboard: '+str(len(data['scenes']))+' scenes')
