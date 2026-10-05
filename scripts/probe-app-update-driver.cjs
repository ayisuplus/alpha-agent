/** Executes production desktop IPC; the restarted process uses production main directly. */
const { app, BaseWindow, webContents } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const root = process.env.ALPHA_UPDATE_PROBE_ROOT;
const evidence = process.env.ALPHA_UPDATE_PROBE_EVIDENCE;
require(path.join(root, "desktop/main.cjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    let page;
    for (let count = 0; count < 600; count++) {
      BaseWindow.getAllWindows().forEach(window => window.hide());
      page = webContents.getAllWebContents().find(page => /\/ui\//.test(page.getURL()));
      if (page && await page.executeJavaScript("!!document.querySelector('.native-workbench')")) break;
      await sleep(100);
    }
    if (!page) throw new Error("Production workbench did not load");
    const prepared = await page.executeJavaScript(`(async()=>{
      const api=async(path,input)=>{const response=await fetch('/api/native/'+path,{method:input===undefined?'GET':'POST',headers:{'x-alpha-token':await window.alpha.serverToken(),'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data;};
      const {session}=await api('sessions',{title:'UPDATE_SESSION_PROOF',cwd:${JSON.stringify(process.env.ALPHA_UPDATE_PROBE_PROJECT)}}); await api('sessions/'+session.id+'/open',{});
      await api('sessions/'+session.id+'/command',{type:'prompt',message:'Keep this native session across the application update.'});
      for(let count=0;count<200;count++){if((await api('sessions/'+session.id+'/state')).isSettled)break;await new Promise(resolve=>setTimeout(resolve,100));}
      const state=await api('sessions/'+session.id+'/state');
      window.alpha.storage('setItem','alpha-last-session',session.id);
      window.alpha.storage('setItem','alpha-ui-preferences',JSON.stringify({language:'en',font:'segoe',notifications:false,sound:false}));
      window.alpha.storage('setItem','alpha-composer:'+session.id,JSON.stringify({text:'UPDATE_DRAFT_MUST_SURVIVE',paths:[]}));
      const result=await api('app-updates',{action:'prepare',path:${JSON.stringify(process.env.ALPHA_UPDATE_PROBE_CANDIDATE)}});
      return {id:result.id,sessionId:session.id,nativeSessionId:state.sessionId};
    })()`);
    writeFileSync(path.join(evidence, "handoff.json"), JSON.stringify({ ...prepared, oldPid: process.pid }));
    await page.executeJavaScript(`window.alpha.installUpdate(${JSON.stringify(prepared.id)})`);
  } catch (error) { writeFileSync(path.join(evidence, "failure.txt"), String(error.stack || error)); console.error(error); process.exitCode = 1; app.quit(); }
});
