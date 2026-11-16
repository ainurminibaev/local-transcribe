import test from 'node:test';
import assert from 'node:assert/strict';
import {notifyJob,alreadyAccepted} from './notifications.ts';
function setup() {
 const data=new Map(),accepted=[],history=[];let attempts=0;
 const options={};
 const kv={get:async key=>structuredClone(data.get(key)),set:async(key,val)=>data.set(key,structuredClone(val))};
 const threads={get:async()=>({archivedAt:options.archived?1:null}),queuedMessages:{list:async()=>accepted},
 timeline:async()=>({rows:history,timelinePage:{olderCursor:null}}),send:async args=>{
  attempts++;if(options.offline)throw new Error('offline');
  accepted.push(args);if(options.lostAck)throw new Error('lost acknowledgement');
  return {ok:true,delivery:'queued',queuedMessage:{id:'queued-1'}};
 }};
 const job={id:'job-123',state:'completed',notifyOnFinish:true,threadId:'thread-1'};
 return {data,accepted,history,kv,threads,job,options,get attempts(){return attempts},tick:now=>notifyJob({kv,threads,job,now})};
}
test('completion wakes once, queues behind busy work, and survives restarted notifier',async()=>{
 const s=setup();await s.tick(1);await s.tick(2);
 await notifyJob({kv:s.kv,threads:s.threads,job:s.job,now:999999});
 assert.equal(s.attempts,1);assert.equal(s.accepted[0].mode,'queue');
 assert.match(s.accepted[0].input[0].text,/job-123/);
 assert.equal(s.data.get('notice:job-123:completed').queuedMessageId,'queued-1');
});
test('running jobs, legacy jobs, opt-out and absent thread never wake a model',async()=>{
 const s=setup();for(const patch of [{state:'running'},{notifyOnFinish:false},{threadId:null}])
  await notifyJob({kv:s.kv,threads:s.threads,job:{...s.job,...patch}});
 assert.equal(s.attempts,0);
});
test('cancelled jobs and archived threads do not wake the agent',async()=>{
 const s=setup();s.job.state='cancelled';await s.tick(1);s.job.state='completed';s.options.archived=true;await s.tick(2);
 assert.equal(s.attempts,0);assert.equal(s.data.get('notice:job-123:cancelled').status,'suppressed');
});
test('failure and failed artifact delivery notify once with delivery recovery instructions',async()=>{
 const s=setup();for(const state of ['failed','return_failed']){s.job.state=state;await s.tick(1);await s.tick(2);}
 assert.equal(s.attempts,2);assert.match(s.accepted[1].input[0].text,/не ASR/);
});
test('lost acknowledgement recovered from queued message after restart without duplicate',async()=>{
 const s=setup();s.options.lostAck=true;await s.tick(1);await s.tick(60002);
 assert.equal(s.attempts,1);assert.equal(s.data.get('notice:job-123:completed').recovered,true);
});
test('lost acknowledgement recovered from dispatched history without duplicate',async()=>{
 const s=setup();s.options.lostAck=true;await s.tick(1);s.history.push(s.accepted.pop());await s.tick(60002);
 assert.equal(s.attempts,1);assert.equal(s.data.get('notice:job-123:completed').status,'sent');
});
test('unaccepted notification retries after backoff and preserves ASR job',async()=>{
 const s=setup();s.options.offline=true;await s.tick(1);await s.tick(100);
 assert.equal(s.attempts,1);s.options.offline=false;await s.tick(60002);assert.equal(s.attempts,2);
 assert.equal(s.job.state,'completed');assert.equal(s.data.get('notice:job-123:completed').status,'sent');
});
test('recovery pages older history rather than sending a duplicate',async()=>{
 const calls=[];const threads={queuedMessages:{list:async()=>[]},timeline:async args=>{
  calls.push(args);return args.beforeAnchorId?{rows:[{text:'marker'}],timelinePage:{olderCursor:null}}:
   {rows:[],timelinePage:{olderCursor:{anchorId:'anchor',anchorSeq:10}}};
 }};
 assert.equal(await alreadyAccepted(threads,'thread','marker'),true);assert.equal(calls[1].beforeAnchorSeq,'10');
});
