import base64,copy,json,re,sys
from pathlib import Path
from google.protobuf import descriptor_pb2,descriptor_pool,message_factory,json_format
import google.protobuf

if len(sys.argv)!=2: raise SystemExit('Usage: python3 scripts/verify-local-trace.py ARTIFACT_DIRECTORY')
base=Path(sys.argv[1])
descriptor=descriptor_pb2.FileDescriptorSet.FromString((base/'trace.descriptor.pb').read_bytes())
pool=descriptor_pool.DescriptorPool()
pending=list(descriptor.file)
while pending:
    before=len(pending)
    for file in pending[:]:
        try: pool.Add(file)
        except TypeError: continue
        pending.remove(file)
    assert len(pending)<before,'Unresolved schema imports'
Request=message_factory.GetMessageClass(pool.FindMessageTypeByName('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'))

def normalize(obj,desc):
    assert isinstance(obj,dict)
    fields={f.json_name:f for f in desc.fields}
    result={}
    for key,value in obj.items():
        assert key in fields,'Unknown/non-camelCase field'
        f=fields[key]
        def item(v):
            if f.message_type: return normalize(v,f.message_type)
            if f.type==f.TYPE_ENUM:
                assert type(v)==int and v in f.enum_type.values_by_number,'Non-integer/unknown enum'
            if f.type==f.TYPE_BYTES and key in ('traceId','spanId','parentSpanId'):
                n=32 if key=='traceId' else 16
                assert isinstance(v,str) and re.fullmatch('[0-9a-fA-F]{'+str(n)+'}',v),'Invalid hex ID'
                assert int(v,16)!=0,'Zero ID'
                return base64.b64encode(bytes.fromhex(v)).decode()
            if f.type in (f.TYPE_UINT64,f.TYPE_FIXED64):
                assert isinstance(v,str) and re.fullmatch('[0-9]+',v) and int(v)<2**64,'Invalid uint64'
            return v
        result[key]=[item(v) for v in value] if f.is_repeated else item(value)
    return result

def decode(record):
    msg=json_format.ParseDict(normalize(record,Request.DESCRIPTOR),Request(),ignore_unknown_fields=False)
    wire=msg.SerializeToString();assert Request.FromString(wire)==msg
    for r in msg.resource_spans:
        for scope in r.scope_spans:
            for s in scope.spans:
                assert len(s.trace_id)==16 and len(s.span_id)==8
                assert not s.parent_span_id or len(s.parent_span_id)==8
                assert s.start_time_unix_nano<=s.end_time_unix_nano
    return msg

records=[json.loads(line) for line in (base/'fixture.otlp.jsonl').read_text().splitlines()]
spans=[s for record in records for r in decode(record).resource_spans for scope in r.scope_spans for s in scope.spans]
assert len({(s.trace_id,s.span_id) for s in spans})==len(spans)
assert [s.status.code for s in spans if s.name=='provider.end']==[1,2,0,0]
assert spans[6].parent_span_id==spans[5].span_id
assert spans[8].span_id!=spans[9].span_id
bad=[]
def modified(mutate):
    r=copy.deepcopy(records[0]);mutate(r['resourceSpans'][0]['scopeSpans'][0]['spans'][0]);return r
bad.append(modified(lambda s:s.update(traceId='not-hex')))
bad.append(modified(lambda s:s.update(spanId='0'*16)))
bad.append(modified(lambda s:s.update(kind='SPAN_KIND_INTERNAL')))
bad.append(modified(lambda s:s.update(start_time_unix_nano='1')))
bad.append(modified(lambda s:s.update(startTimeUnixNano='-1')))
bad.append(modified(lambda s:s['attributes'][0].update(value={'doubleValue':'not-a-number'})))
for record in bad:
    try:decode(record)
    except (AssertionError,json_format.ParseError,ValueError,TypeError):pass
    else:raise AssertionError('Malformed fixture accepted')
result={'pythonProtobuf':google.protobuf.__version__,'validRequests':len(records),'validSpans':len(spans),'rejectedMalformedFixtures':len(bad),'binaryRoundtrips':len(records),'scope':'Official trace schema via protobufjs descriptor; independent Python protobuf parser and binary roundtrip, with explicit OTLP JSON deviations. No Collector, SDK context or network transport validation.'}
(base/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
