// Explicit local desktop packaging. Never creates signing assets or reads secrets.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const client=fileURLToPath(new URL('../',import.meta.url)),repo=resolve(client,'../..');
const channel=process.argv[2], notarize=process.argv.includes('--notarize');
function fail(message){process.stderr.write(message+'\n');process.exit(1);}
if(!['preview','production'].includes(channel))fail('Usage: package-desktop.mjs preview|production [--notarize]');
if(process.platform!=='darwin'||process.arch!=='arm64')fail('This verified workflow currently supports macOS arm64 only; Windows/Linux packaging is not verified.');
if(channel==='preview'&&notarize)fail('Preview is an ad-hoc local test build; notarization belongs to explicit production workflow.');
function run(command,args,options={}){const r=spawnSync(command,args,{cwd:client,encoding:'utf8',...options});if(r.error||r.status!==0)throw Error(`${command} failed${r.error?': '+r.error.message:''}`);return r.stdout?.trim()||'';}
const version=JSON.parse(readFileSync(join(client,'package.json'))).version;
if(!/^\d+\.\d+\.\d+$/.test(version))fail('Client version must be numeric major.minor.patch.');
let sha,dirty,build;
try{sha=run('git',['rev-parse','HEAD']);dirty=!!run('git',['status','--porcelain']);build=process.env.PIBOT_BUILD_NUMBER||run('git',['rev-list','--count','HEAD']);}catch{fail('Packaging requires a Git checkout and readable build metadata.');}
if(!/^\d{1,4}$/.test(build))fail('PIBOT_BUILD_NUMBER must contain 1-4 digits.');
let identity='-',profile;
if(channel==='production'){
 identity=process.env.APPLE_SIGNING_IDENTITY;profile=process.env.PIBOT_NOTARY_PROFILE;
 if(!identity||identity==='-'||!profile)fail('Production blocked: set an existing Developer ID APPLE_SIGNING_IDENTITY and PIBOT_NOTARY_PROFILE (Keychain profile reference). No signing or upload attempted.');
 if(dirty)fail('Production blocked: source checkout must be clean.');
 let identities;try{identities=run('security',['find-identity','-v','-p','codesigning']);}catch{fail('Production blocked: cannot inspect valid signing identities.');}
 const match=identities.split('\n').find(line=>line.includes(identity));
 if(!match?.includes('Developer ID Application:'))fail('Production blocked: no matching valid Developer ID Application identity.');
}
const env={...process.env};for(const key of ['APPLE_ID','APPLE_PASSWORD','APPLE_API_ISSUER','APPLE_API_KEY','APPLE_API_KEY_PATH'])delete env[key];
env.APPLE_SIGNING_IDENTITY=identity;
const config=join(client,`src-tauri/tauri.${channel}.conf.json`);
const override=JSON.stringify({bundle:{macOS:{bundleVersion:build,signingIdentity:identity}}});
try{
 run('npm',['run','build:gui'],{stdio:'inherit',env});
 run('npm',['run','tauri','--','build','--bundles','app','--config',config,'--config',override],{stdio:'inherit',env});
 const name=channel==='preview'?'Pi Bot Preview':'Pi Bot';const app=join(client,`src-tauri/target/release/bundle/macos/${name}.app`);
 if(!existsSync(app))throw Error('Expected app bundle missing');
 run('codesign',['--verify','--deep','--strict',app]);
 if(channel==='production'){
  const signature=spawnSync('codesign',['-d','--verbose=4',app],{encoding:'utf8'}).stderr||'';
  if(!signature.includes('runtime')||signature.includes('Signature=adhoc'))throw Error('Production candidate lacks hardened runtime/distribution signature');
 }
 const out=join(repo,'artifacts/releases');mkdirSync(out,{recursive:true});
 let stem=`Pi-Bot-${channel==='preview'?'Preview':'Production-Candidate'}-${version}-macos-arm64-${sha.slice(0,7)}${dirty?'-dirty':''}`;
 let zip=join(out,stem+'.zip');run('ditto',['-c','-k','--keepParent',app,zip]);
 if(notarize){
  // Explicit flag performs an upload. The assistant never invokes it without authorization.
  const submitted=run('xcrun',['notarytool','submit',zip,'--keychain-profile',profile,'--wait','--output-format','json']);
  const result=JSON.parse(submitted);if(result.status!=='Accepted')throw Error('Apple notarization was not accepted');
  run('xcrun',['stapler','staple',app]);run('xcrun',['stapler','validate',app]);run('spctl',['--assess','--type','execute',app]);stem=stem.replace('Production-Candidate','Production');zip=join(out,stem+'.zip');run('ditto',['-c','-k','--keepParent',app,zip]);
 }
 const digest=createHash('sha256').update(readFileSync(zip)).digest('hex');
 const metadata={channel,version,buildNumber:build,sourceCommit:sha,dirty,platform:'macos',architecture:'arm64',identifier:channel==='preview'?'dev.pibot.desktop.preview':'dev.pibot.desktop',signature:channel==='preview'?'ad-hoc':'Developer ID',notarized:notarize,productionReady:channel==='production'&&notarize,sha256:digest,node:process.version,rust:run('rustc',['--version']),xcode:run('xcodebuild',['-version'])};
 writeFileSync(join(out,stem+'.json'),JSON.stringify(metadata,null,2)+'\n');writeFileSync(zip+'.sha256',`${digest}  ${stem}.zip\n`);
 process.stdout.write(`Created ${zip}\n${notarize?'Signed and notarized.':channel==='preview'?'Preview only: ad-hoc signed, not notarized.':'Signed production candidate only: explicit --notarize upload still required.'}\n`);
}catch(e){fail(e.message);}
