const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness({failedWeek = -1, tabs = true} = {}) {
  const data = {settings:{base:'http://127.0.0.1:8000',key:'UPLOAD_SECRET'}};
  const calls = [], messages = [];
  let listener;
  const weekList = [1,2].map(x => ({monday:`2026-11-${x === 1 ? '02':'09'}`,url:`https://www.lectio.dk/lectio/21/SkemaNy.aspx?klasseid=31&week=${x === 1 ? '45':'46'}2026`}));
  const chrome = {
    storage:{local:{setAccessLevel:async () => { throw new Error('not supported for local'); },get:async () => data,set:async values => Object.assign(data,values)}},
    runtime:{id:'ext',getURL:name => 'chrome-extension://ext/'+name,
      onMessage:{addListener:f => listener=f},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    alarms:{get:async () => ({}),create:async () => {},onAlarm:{addListener(){}}},
    tabs:{query:async () => tabs ? [{id:7,url:'https://www.lectio.dk/lectio/21/forside.aspx'}]:[],sendMessage:async (id,m) => {
      messages.push(m);
      return messages.length-1 === failedWeek ? {ok:false,error:'Sign in again'} :
        {ok:true,url:m.url,emptyMarker:false,lessons:[{subject:'MA',teachers:'',room:'',start_date:m.monday,start_time:'08:00',
          end_date:m.monday,end_time:'09:00',all_day:false,notes:'MA',activity_id:null,cancelled:false}]};
    }}
  };
  const fetch = async (url,options) => {
    calls.push({url,options});
    return {ok:true,json:async () => options.method === 'POST' ? {lessons:2,last_synced:'2026-11-09T12:00:00Z'} :
      {school_id:21,class_id:31,weeks:weekList,view_path:'/class/21/31#key=FEED_SECRET'}};
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome,fetch,AbortSignal,Date,Error});
  const run = () => new Promise(resolve => listener({type:'SYNC'},{id:'ext',url:'chrome-extension://ext/popup.html'},resolve));
  return {run,calls,messages,data,listener};
}

test('authenticated browser weeks are uploaded atomically; secret never enters content script',async () => {
  const h=harness();
  assert.equal((await h.run()).ok,true);
  assert.equal(h.messages.length,2);
  assert.ok(h.messages.every(m => Object.keys(m).sort().join(',') === 'monday,type,url'));
  const post=h.calls.find(c => c.options.method === 'POST');
  assert.equal(post.options.headers.Authorization,'Bearer UPLOAD_SECRET');
  assert.equal(post.options.credentials,'omit');
  assert.equal(post.options.redirect,'error');
  const body=JSON.parse(post.options.body);
  assert.equal(body.weeks.length,2);
  assert.ok(body.weeks.every(w => Array.isArray(w.lessons) && !('html' in w)), 'only parsed lessons are uploaded');
  assert.ok(!post.options.body.includes('UPLOAD_SECRET'));
  assert.equal(h.data.status.viewUrl,'http://127.0.0.1:8000/class/21/31#key=FEED_SECRET');
});

test('expired session cannot upload partial calendar',async () => {
  const h=harness({failedWeek:1});
  const result=await h.run();
  assert.equal(result.ok,false);
  assert.match(result.error,/Sign in/);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length,0);
  assert.equal(h.data.status.ok,false);
});

test('missing Lectio tab explains how to resume',async () => {
  const h=harness({tabs:false});
  assert.match((await h.run()).error,/Open Lectio/);
  assert.equal(h.messages.length,0);
});

test('content scripts cannot trigger a synchronization',() => {
  const h=harness();
  let replied=false;
  h.listener({type:'SYNC'},{id:'ext',url:'https://www.lectio.dk/lectio/21/forside.aspx'},() => replied=true);
  assert.equal(replied,false);
  assert.equal(h.calls.length,0);
});
